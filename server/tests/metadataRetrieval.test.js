import { createMetadataRetrievalService, retrieveTrackMetadata } from '../src/services/metadataRetrievalService.js';

const currentTrack = {
  trackId: 't_4101', title: 'Blue Hour', artist: 'Mira Vale',
  acoustic: { bpm: 128, camelotKey: '9A', energy: 0.8, valence: 0.7 },
  timeline: [
    { ts: 12, type: 'trivia', text: 'The track opens with a soft synthesizer texture.' },
    { ts: 35, type: 'sample_credit', text: 'The chorus uses a hand-played kalimba phrase.' },
  ],
};
const lounge = { loungeId: 'lg_410000000001', status: 'live', currentTrackId: currentTrack.trackId, participantIds: ['member-1'] };
const query = (value) => ({ select() { return this; }, lean: async () => value });
function service({ room = lounge, track = currentTrack, now = () => 1_000_000, questionLimit = 10 } = {}) {
  return createMetadataRetrievalService({
    loungeModel: { findOne: () => query(room) },
    trackModel: { findOne: () => ({ select() { return this; }, lean: async () => track }) },
    now,
    questionLimit,
  });
}

test('lexical retrieval ranks an applicable metadata timeline chunk with its stable catalog reference', () => {
  expect(retrieveTrackMetadata(currentTrack, 'Where does the sample come from?', 3)[0]).toMatchObject({
    reference: 't_4101#timeline[1]',
    text: 'The chorus uses a hand-played kalimba phrase.',
    kind: 'timeline',
  });
});

test('answers acoustic questions from validated profile fields and cites the exact field', async () => {
  const result = await service().answerQuestion({ loungeId: lounge.loungeId, userId: 'member-1', question: 'What is the BPM?' });
  expect(result).toEqual({
    trackId: 't_4101', answer: 'The catalog lists the BPM as 128 BPM.',
    sourceEvents: ['t_4101#acoustic.bpm'], grounded: true, provider: 'deterministic_metadata_retrieval',
  });
});

test('answers sample questions only by quoting retrieved source text and citing that timeline entry', async () => {
  const result = await service().answerQuestion({ loungeId: lounge.loungeId, userId: 'member-1', question: 'Where does the sample come from?' });
  expect(result.answer).toBe('The available track metadata says: “The chorus uses a hand-played kalimba phrase.”');
  expect(result.sourceEvents).toEqual(['t_4101#timeline[1]']);
  expect(result.grounded).toBe(true);
});

test('every grounded Q&A reference resolves to an entry on the current track', async () => {
  const cases = [
    ['What is the BPM?', 't_4101#acoustic.bpm'],
    ['Who is the artist?', 't_4101#artist'],
    ['Where does the sample come from?', 't_4101#timeline[1]'],
  ];
  for (const [question, expectedReference] of cases) {
    const result = await service().answerQuestion({ loungeId: lounge.loungeId, userId: 'member-1', question });
    expect(result.sourceEvents).toEqual([expectedReference]);
    const [trackId, pointer] = expectedReference.split('#');
    expect(trackId).toBe(currentTrack.trackId);
    const exists = pointer === 'title' || pointer === 'artist'
      ? Boolean(currentTrack[pointer])
      : pointer.startsWith('acoustic.')
        ? currentTrack.acoustic?.[pointer.slice('acoustic.'.length)] !== undefined
        : Boolean(currentTrack.timeline[Number(pointer.match(/^timeline\[(\d+)\]$/)?.[1])]);
    expect(exists).toBe(true);
  }
});

test('declines unsupported artist attributes instead of treating an artist name as the answer', async () => {
  const result = await service().answerQuestion({ loungeId: lounge.loungeId, userId: 'member-1', question: 'What is the artist age?' });
  expect(result).toMatchObject({
    answer: 'I do not have supporting metadata for that question about this track.',
    sourceEvents: [], grounded: false,
  });
});

test('declines unsupported questions without sources rather than inventing lyrics or biography', async () => {
  const result = await service().answerQuestion({ loungeId: lounge.loungeId, userId: 'member-1', question: 'What are the lyrics about?' });
  expect(result).toMatchObject({
    answer: 'I do not have supporting metadata for that question about this track.',
    sourceEvents: [], grounded: false,
  });
});

test('omits malformed profile and timeline entries from retrieval and response sources', async () => {
  const malformed = {
    ...currentTrack,
    acoustic: { bpm: 0, camelotKey: '13Z', energy: 2, valence: -1 },
    timeline: [{ ts: -1, type: 'external_bio', text: 'Untrusted unvalidated claim.' }, null],
  };
  const results = retrieveTrackMetadata(malformed, 'What is the BPM?');
  expect(results).toEqual([]);
  const answer = await service({ track: malformed }).answerQuestion({ loungeId: lounge.loungeId, userId: 'member-1', question: 'What is the BPM?' });
  expect(answer).toMatchObject({ grounded: false, sourceEvents: [] });
});

test('identical supported questions produce stable answers and source references', async () => {
  const retrieval = service();
  const request = { loungeId: lounge.loungeId, userId: 'member-1', question: 'Where does the sample come from?' };
  const first = await retrieval.answerQuestion(request);
  const second = await retrieval.answerQuestion(request);
  expect(second).toEqual(first);
});

test('requires active Lounge membership and a current track before retrieval', async () => {
  await expect(service().answerQuestion({ loungeId: lounge.loungeId, userId: 'intruder', question: 'What is the BPM?' })).rejects.toMatchObject({ status: 403, code: 'LOUNGE_MEMBERSHIP_REQUIRED' });
  await expect(service({ room: { ...lounge, status: 'scheduled' } }).answerQuestion({ loungeId: lounge.loungeId, userId: 'member-1', question: 'What is the BPM?' })).rejects.toMatchObject({ status: 409, code: 'TRACK_NOT_PLAYING' });
  await expect(service({ room: { ...lounge, currentTrackId: null } }).answerQuestion({ loungeId: lounge.loungeId, userId: 'member-1', question: 'What is the BPM?' })).rejects.toMatchObject({ status: 409, code: 'TRACK_NOT_PLAYING' });
});

test('rate limits questions per member and Lounge over the configured window', async () => {
  let now = 1_000_000;
  const retrieval = service({ now: () => now, questionLimit: 2 });
  const ask = () => retrieval.answerQuestion({ loungeId: lounge.loungeId, userId: 'member-1', question: 'What is the BPM?' });
  await ask(); await ask();
  await expect(ask()).rejects.toMatchObject({ status: 429, code: 'AI_QUESTION_RATE_LIMITED' });
  now += 60_001;
  await expect(ask()).resolves.toMatchObject({ grounded: true });
});
