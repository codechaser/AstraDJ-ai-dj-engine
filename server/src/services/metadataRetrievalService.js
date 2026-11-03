import { DJLounge } from '../models/DJLounge.js';
import { QueueEvent } from '../models/QueueEvent.js';
import { Track } from '../models/Track.js';
import { ApiError } from '../utils/ApiError.js';
import { assertRateLimit, distributedRateLimiter } from './distributedRateLimiter.js';
import { rateLimitPolicies } from '../config/rateLimitPolicy.js';

const QUESTION_WINDOW_MS = 60_000;
const QUESTION_LIMIT = 10;
const validCamelotKeys = new Set(Array.from({ length: 12 }, (_, index) => [`${index + 1}A`, `${index + 1}B`]).flat());
const isSafeCatalogText = (value, maxLength) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength && !/[<>\u0000-\u001f]/.test(value);
const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'about', 'by', 'can', 'does', 'for', 'from', 'give', 'i', 'is', 'it', 'me', 'of', 'on', 'please', 'tell', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'who', 'why', 'with']);
const normalizeToken = (token) => ({ sampled: 'sample', samples: 'sample', sampling: 'sample', produced: 'produce', producer: 'produce', producing: 'produce', recorded: 'record', recording: 'record', lyrics: 'lyric', tracks: 'track' })[token] ?? token;
const tokenize = (value) => String(value ?? '').toLowerCase().match(/[a-z0-9]+/g)?.map(normalizeToken).filter((token) => token.length > 1 && !STOP_WORDS.has(token)) ?? [];

export function buildTrackDocuments(track) {
  if (!track || typeof track.trackId !== 'string') return [];
  const documents = [];
  for (const field of ['title', 'artist']) {
    if (isSafeCatalogText(track[field], 120)) {
      documents.push({ reference: `${track.trackId}#${field}`, text: track[field].trim(), kind: field, terms: tokenize(`${field} ${track[field]}`) });
    }
  }
  const acoustic = track.acoustic && typeof track.acoustic === 'object' ? track.acoustic : {};
  for (const [field, value, label] of [
    ['bpm', acoustic.bpm, 'bpm tempo beats per minute'],
    ['camelotKey', acoustic.camelotKey, 'key camelot musical harmonic'],
    ['energy', acoustic.energy, 'energy intensity'],
    ['valence', acoustic.valence, 'valence mood positivity'],
  ]) {
    const valid = field === 'bpm' ? Number.isFinite(value) && value > 0 && value <= 300
      : field === 'camelotKey' ? validCamelotKeys.has(value)
        : Number.isFinite(value) && value >= 0 && value <= 1;
    if (valid) {
      documents.push({ reference: `${track.trackId}#acoustic.${field}`, text: `${label}: ${value}`, kind: field, value, terms: tokenize(label) });
    }
  }
  if (Array.isArray(track.timeline)) track.timeline.forEach((entry, index) => {
    if (!entry || !isSafeCatalogText(entry.text, 500) || !Number.isFinite(entry.ts) || entry.ts < 0 || !['sample_credit', 'trivia', 'glossary'].includes(entry.type)) return;
    documents.push({ reference: `${track.trackId}#timeline[${index}]`, text: entry.text.trim(), kind: 'timeline', timelineType: entry.type, terms: tokenize(`${entry.type.replace('_', ' ')} ${entry.text}`) });
  });
  return documents;
}

export function retrieveTrackMetadata(track, question, limit = 3) {
  const questionTerms = [...new Set(tokenize(question))];
  if (!questionTerms.length) return [];
  return buildTrackDocuments(track)
    .map((document, index) => {
      const terms = new Set(document.terms);
      const matches = questionTerms.filter((term) => terms.has(term)).length;
      const fieldBoost = questionTerms.some((term) => document.terms.includes(term)) && document.kind !== 'timeline' ? 0.2 : 0;
      return { ...document, _score: matches / questionTerms.length + fieldBoost, _matches: matches, _order: index };
    })
    .filter((document) => document._matches > 0)
    .sort((a, b) => b._score - a._score || a._order - b._order)
    .slice(0, limit)
    .map(({ _score, _matches, _order, ...document }) => document);
}

export function reconstructRecentTrackIds(currentTrackId, events, limit = 10) {
  if (typeof currentTrackId !== 'string' || !Array.isArray(events)) return [];
  const seenSeq = new Set();
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const playback = [];
  for (const event of ordered) {
    const fromTrackId = event?.payload?.fromTrackId;
    const trackId = event?.payload?.trackId;
    if (event?.type !== 'track.transitioned' || !Number.isSafeInteger(event.seq) || event.seq < 1
      || seenSeq.has(event.seq) || typeof fromTrackId !== 'string' || !fromTrackId
      || typeof trackId !== 'string' || !trackId || fromTrackId === trackId) continue;
    seenSeq.add(event.seq);
    if (!playback.length) playback.push(fromTrackId, trackId);
    else if (playback.at(-1) === fromTrackId) playback.push(trackId);
    // A discontinuous edge cannot safely establish chronology. Ignore it;
    // later edges may still extend the last verified point.
  }
  if (playback.at(-1) !== currentTrackId) return [];
  playback.pop(); // exclude the authoritative current occurrence, not prior repeats
  return playback.reverse().slice(0, limit);
}

function structuredAnswer(track, question) {
  const q = question.toLowerCase();
  // A field keyword alone does not mean the catalog can answer the attribute
  // being asked for (for example, returning an artist name for an age query).
  // Let the normal retrieval path decline those questions unless a matching
  // authored timeline entry actually supports them.
  const unsupportedArtistAttributes = /\b(age|old|young|country|nationality|birth|born|genre|biography|location|from|popular|famous|produced|producer)\b/;
  if (/\b(artist|singer|band)\b/.test(q) && unsupportedArtistAttributes.test(q)) return null;
  const candidates = [
    { pattern: /\b(bpm|tempo|beats per minute)\b/, field: 'bpm', label: 'BPM', format: (value) => `${value} BPM` },
    { pattern: /\b(camelot|musical key|harmonic key|key)\b/, field: 'camelotKey', label: 'Camelot key', format: (value) => String(value) },
    { pattern: /\b(energy|intensity)\b/, field: 'energy', label: 'energy', format: (value) => String(value) },
    { pattern: /\b(valence|mood score|positivity)\b/, field: 'valence', label: 'valence', format: (value) => String(value) },
    { pattern: /\b(artist|singer|band)\b/, field: 'artist', label: 'artist', format: (value) => String(value) },
    { pattern: /\b(title|track name|song name|called)\b/, field: 'title', label: 'title', format: (value) => String(value) },
  ];
  const candidate = candidates.find(({ pattern }) => pattern.test(q));
  if (!candidate) return null;
  if (candidate.field === 'artist' && !/\bwho\b|\b(?:artist|singer|band)\s+name\b|\b(?:name|identify)\b.{0,20}\b(?:artist|singer|band)\b/.test(q)) return null;
  const value = candidate.field === 'artist' || candidate.field === 'title' ? track[candidate.field] : track.acoustic?.[candidate.field];
  if (value === undefined || value === null || value === '' || !Number.isFinite(value) && typeof value !== 'string') return null;
  const document = buildTrackDocuments(track).find((item) => item.reference === `${track.trackId}#${candidate.field === 'artist' || candidate.field === 'title' ? candidate.field : `acoustic.${candidate.field}`}`);
  if (!document) return null;
  return { answer: `The catalog lists the ${candidate.label} as ${candidate.format(value)}.`, sourceEvents: [document.reference] };
}

export function createMetadataRetrievalService({ loungeModel = DJLounge, trackModel = Track, queueEventModel = QueueEvent, now = () => Date.now(), rateLimiter = distributedRateLimiter, questionLimit = QUESTION_LIMIT, windowMs = QUESTION_WINDOW_MS } = {}) {
  return {
    async answerQuestion({ loungeId, userId, question, rateLimiter: activeRateLimiter = rateLimiter }) {
      const lounge = await loungeModel.findOne({ loungeId, status: { $ne: 'ended' } }).lean();
      if (!lounge) throw new ApiError(404, 'LOUNGE_NOT_FOUND', 'Lounge not found or ended');
      if (!lounge.participantIds?.some((participantId) => String(participantId) === String(userId))) throw new ApiError(403, 'LOUNGE_MEMBERSHIP_REQUIRED', 'Join this Lounge before asking the AI DJ');
      if (lounge.status !== 'live' || !lounge.currentTrackId) throw new ApiError(409, 'TRACK_NOT_PLAYING', 'The Lounge has no current track to ask about');

      await assertRateLimit(activeRateLimiter, {
        ...rateLimitPolicies.aiQuestion,
        limit: questionLimit,
        windowMs,
      }, [String(userId), loungeId]);

      const trackFields = 'trackId title artist acoustic timeline';
      const track = await trackModel.findOne({ trackId: lounge.currentTrackId }).select(trackFields).lean();
      if (!track) throw new ApiError(404, 'CURRENT_TRACK_NOT_FOUND', 'The current Lounge track does not exist in the catalog');
      const transitionEvents = await queueEventModel.find({ loungeId, type: 'track.transitioned' }).sort({ seq: -1 }).limit(500).lean();
      const recentTrackIds = reconstructRecentTrackIds(lounge.currentTrackId, transitionEvents);
      const recentTracks = recentTrackIds.length
        ? await trackModel.find({ trackId: { $in: recentTrackIds } }).select(trackFields).lean()
        : [];
      const recentById = new Map(recentTracks.map((item) => [item.trackId, item]));
      const recent = recentTrackIds.map((id) => recentById.get(id)).filter(Boolean);
      const previous = recent[0] ?? null;
      const q = question.toLowerCase();
      const unsupported = (answer, trackIds = []) => ({
        trackId: track.trackId, answer, sourceEvents: [], grounded: false,
        provider: 'deterministic_metadata_retrieval', contextTrackIds: trackIds,
      });
      if (/\b(before this|previous track|track before|song before|played before)\b/.test(q)) {
        if (!previous?.title) return unsupported('I cannot identify the previous track from this Lounge’s persisted transitions.');
        if (/\b(produc|sample|credit|trivia)\w*\b/.test(q)) {
          const fact = retrieveTrackMetadata(previous, question, 3).find((document) => document.kind === 'timeline');
          if (!fact) return unsupported(`I do not have supporting ${/\bsample|credit\w*\b/.test(q) ? 'sample-credit' : 'producer'} metadata for the previous track.`, [previous.trackId]);
          return { trackId: track.trackId, answer: `The available metadata for ${previous.title} says: “${fact.text}”`, sourceEvents: [fact.reference], grounded: true, provider: 'deterministic_metadata_retrieval', contextTrackIds: [previous.trackId] };
        }
        const titleRef = `${previous.trackId}#title`;
        const titleDoc = buildTrackDocuments(previous).find((doc) => doc.reference === titleRef);
        if (!titleDoc) return unsupported('I do not have supporting metadata for the previous track.');
        const refs = [titleRef];
        let answer = `The track before ${track.title} was ${titleDoc.text}`;
        const artistDoc = buildTrackDocuments(previous).find((doc) => doc.reference === `${previous.trackId}#artist`);
        if (artistDoc) { answer += ` by ${artistDoc.text}`; refs.push(artistDoc.reference); }
        answer += '.';
        return { trackId: track.trackId, answer, sourceEvents: refs, grounded: true, provider: 'deterministic_metadata_retrieval', contextTrackIds: [previous.trackId] };
      }
      if (/\b(compare|compared)\b/.test(q) && /\b(previous|last|before)\b/.test(q)) {
        if (!previous?.acoustic?.bpm || !track.acoustic?.bpm) return unsupported('I do not have BPM metadata for both tracks, so I cannot compare them.', previous ? [previous.trackId] : []);
        return {
          trackId: track.trackId,
          answer: `The current track is ${track.title} at ${track.acoustic.bpm} BPM; the previous track is ${previous.title} at ${previous.acoustic.bpm} BPM.`,
          sourceEvents: [`${track.trackId}#title`, `${track.trackId}#acoustic.bpm`, `${previous.trackId}#title`, `${previous.trackId}#acoustic.bpm`],
          grounded: true, provider: 'deterministic_metadata_retrieval', contextTrackIds: [previous.trackId],
        };
      }
      if (/\b(highest bpm|highest tempo|most bpm|fastest recent)\b/.test(q)) {
        const ranked = recent.filter((item) => Number.isFinite(item.acoustic?.bpm)).sort((a, b) => b.acoustic.bpm - a.acoustic.bpm || a.trackId.localeCompare(b.trackId));
        const winner = ranked[0];
        if (winner) return {
          trackId: track.trackId,
          answer: `Among the recent tracks with BPM metadata, ${winner.title} has the highest BPM at ${winner.acoustic.bpm}.`,
          sourceEvents: [`${winner.trackId}#title`, `${winner.trackId}#acoustic.bpm`], grounded: true,
          provider: 'deterministic_metadata_retrieval', contextTrackIds: [winner.trackId],
        };
        return unsupported('No recent track has BPM metadata that supports this comparison.', recent.map((item) => item.trackId));
      }
      if (/\b(recent|recently played)\b/.test(q)) {
        const timelineFact = recent.flatMap((item) => retrieveTrackMetadata(item, question, 3)
          .filter((document) => document.kind === 'timeline').map((document) => ({ track: item, document })))[0];
        if (timelineFact) return { trackId: track.trackId, answer: `The available metadata for ${timelineFact.track.title} says: “${timelineFact.document.text}”`, sourceEvents: [timelineFact.document.reference], grounded: true, provider: 'deterministic_metadata_retrieval', contextTrackIds: [timelineFact.track.trackId] };
        return unsupported('I do not have supporting metadata for that question about recently played tracks.', recent.map((item) => item.trackId));
      }
      const structured = structuredAnswer(track, question);
      if (structured) return { trackId: track.trackId, ...structured, grounded: true, provider: 'deterministic_metadata_retrieval' };

      const retrieved = retrieveTrackMetadata(track, question, 3);
      const timelineFact = retrieved.find((document) => document.kind === 'timeline');
      if (!timelineFact) return {
        trackId: track.trackId,
        answer: 'I do not have supporting metadata for that question about this track.',
        sourceEvents: [],
        grounded: false,
        provider: 'deterministic_metadata_retrieval',
      };
      return {
        trackId: track.trackId,
        answer: `The available track metadata says: “${timelineFact.text}”`,
        sourceEvents: [timelineFact.reference],
        grounded: true,
        provider: 'deterministic_metadata_retrieval',
      };
    },
  };
}

export const metadataRetrievalService = createMetadataRetrievalService();
