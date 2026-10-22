import { DJLounge } from '../models/DJLounge.js';
import { Track } from '../models/Track.js';
import { ApiError } from '../utils/ApiError.js';

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

export function createMetadataRetrievalService({ loungeModel = DJLounge, trackModel = Track, now = () => Date.now(), questionLimit = QUESTION_LIMIT, windowMs = QUESTION_WINDOW_MS } = {}) {
  const requestsByMember = new Map();
  return {
    async answerQuestion({ loungeId, userId, question }) {
      const lounge = await loungeModel.findOne({ loungeId, status: { $ne: 'ended' } }).lean();
      if (!lounge) throw new ApiError(404, 'LOUNGE_NOT_FOUND', 'Lounge not found or ended');
      if (!lounge.participantIds?.some((participantId) => String(participantId) === String(userId))) throw new ApiError(403, 'LOUNGE_MEMBERSHIP_REQUIRED', 'Join this Lounge before asking the AI DJ');
      if (lounge.status !== 'live' || !lounge.currentTrackId) throw new ApiError(409, 'TRACK_NOT_PLAYING', 'The Lounge has no current track to ask about');

      const key = `${loungeId}:${userId}`;
      const time = now();
      const recent = (requestsByMember.get(key) ?? []).filter((timestamp) => time - timestamp < windowMs);
      if (recent.length >= questionLimit) throw new ApiError(429, 'AI_QUESTION_RATE_LIMITED', 'Too many AI DJ questions; wait before asking again');
      recent.push(time);
      requestsByMember.set(key, recent);

      const track = await trackModel.findOne({ trackId: lounge.currentTrackId }).select('trackId title artist acoustic timeline').lean();
      if (!track) throw new ApiError(404, 'CURRENT_TRACK_NOT_FOUND', 'The current Lounge track does not exist in the catalog');
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
    clearRateLimits() { requestsByMember.clear(); },
  };
}

export const metadataRetrievalService = createMetadataRetrievalService();
