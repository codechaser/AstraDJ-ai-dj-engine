import { createIsolatedMongoTestDatabase, dropIsolatedMongoTestDatabase } from './mongoTestDatabase.js';

const configuredMongoUri = process.env.MONGODB_TEST_URI;
const liveTest = configuredMongoUri ? test : test.skip;

liveTest('Mongo Soundclash persists votes, auto-opens, restores after service restart, and resolves once', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'soundclash');
  let connected = false;
  let firstSoundclash;
  let recoveredSoundclash;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ DJLounge }, { Track }, { queueRepository }, { createQueueService }, { createSoundclashService }, { QueueEvent }] = await Promise.all([
      import('../src/models/DJLounge.js'), import('../src/models/Track.js'), import('../src/services/queueRepository.js'),
      import('../src/services/queueService.js'), import('../src/services/soundclashService.js'), import('../src/models/QueueEvent.js'),
    ]);
    const hostId = new mongoose.Types.ObjectId();
    const firstListenerId = new mongoose.Types.ObjectId();
    const secondListenerId = new mongoose.Types.ObjectId();
    const loungeId = 'lg_930000000001';
    await DJLounge.create({
      loungeId, inviteCode: 'SP-9X2L', hostUserId: hostId, vibeProfile: 'Soundclash integration',
      queue: ['t_9301', 't_9302'], currentTrackId: 't_9301', status: 'live', participantIds: [hostId, firstListenerId, secondListenerId],
      settings: { maxParticipants: 8, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' },
    });
    await Track.create(['t_9301', 't_9302', 't_9303', 't_9304'].map((trackId) => ({
      trackId, title: `Soundclash ${trackId}`, artist: 'Test Fixture', durationSeconds: 180, acoustic: null, timeline: [],
    })));
    const firstQueueService = createQueueService(queueRepository);
    firstSoundclash = createSoundclashService({ repository: queueRepository, queueService: firstQueueService, voteDurationMs: 1200 });
    const lounge = await queueRepository.findLoungeById(loungeId);
    const first = await firstSoundclash.submit({ lounge, actor: { id: firstListenerId, role: 'Listener' }, trackId: 't_9303' });
    expect(first.state.status).toBe('collecting');
    const second = await firstSoundclash.submit({ lounge, actor: { id: secondListenerId, role: 'Listener' }, trackId: 't_9304' });
    expect(second.state).toMatchObject({ status: 'open', openedBy: 'ai_dj', candidateTrackIds: ['t_9303', 't_9304'] });

    await firstSoundclash.vote({ lounge, actor: { id: firstListenerId, role: 'Listener' }, battleId: first.state.battleId, trackId: 't_9303' });
    const durableVote = await QueueEvent.findOne({ loungeId, type: 'soundclash.voted' }).lean();
    expect(String(durableVote.actorUserId)).toBe(String(firstListenerId));
    expect(durableVote.payload).toMatchObject({ battleId: first.state.battleId, trackId: 't_9303' });
    await expect(firstSoundclash.vote({ lounge, actor: { id: firstListenerId, role: 'Listener' }, battleId: first.state.battleId, trackId: 't_9303' }))
      .rejects.toMatchObject({ code: 'SOUNDCLASH_DUPLICATE_VOTE' });

    const persistedBeforeRestart = await QueueEvent.find({ loungeId }).sort({ seq: 1 }).lean();
    expect(persistedBeforeRestart.map(({ type }) => type)).toEqual(['soundclash.submitted', 'soundclash.submitted', 'soundclash.opened', 'soundclash.voted']);
    expect(persistedBeforeRestart[2]).toMatchObject({ actorUserId: null, payload: { openedBy: 'ai_dj', candidateTrackIds: ['t_9303', 't_9304'] } });

    firstSoundclash.close();
    firstQueueService.clear(loungeId);
    const recoveredQueueService = createQueueService(queueRepository);
    recoveredSoundclash = createSoundclashService({ repository: queueRepository, queueService: recoveredQueueService, voteDurationMs: 1200 });
    expect(await recoveredSoundclash.snapshot(lounge)).toMatchObject({ status: 'open', battleId: first.state.battleId, openedBy: 'ai_dj', voteCounts: { t_9303: 1, t_9304: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(await recoveredSoundclash.snapshot(lounge)).toMatchObject({ status: 'resolved', winningTrackId: 't_9303' });
    const resolvedEvents = await QueueEvent.find({ loungeId, type: 'soundclash.resolved' }).lean();
    expect(resolvedEvents).toHaveLength(1);
    expect((await recoveredQueueService.snapshot(lounge)).nextUp[0].trackId).toBe('t_9303');
    expect(await QueueEvent.countDocuments({ loungeId, type: 'soundclash.opened' })).toBe(1);
    expect(await QueueEvent.countDocuments({ loungeId, type: 'soundclash.voted' })).toBe(1);
  } finally {
    firstSoundclash?.close();
    recoveredSoundclash?.close();
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 15000);
