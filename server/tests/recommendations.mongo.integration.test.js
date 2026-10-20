import crypto from 'node:crypto';

const configuredMongoUri = process.env.MONGODB_TEST_URI;
const liveTest = configuredMongoUri ? test : test.skip;

liveTest('MongoDB persists client-reported interactions and supports scoped hybrid recommendations', async () => {
  const mongoose = (await import('mongoose')).default;
  const databaseName = `astradj_recommend_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const mongoUrl = new URL(configuredMongoUri);
  mongoUrl.pathname = `/${databaseName}`;
  const isolatedUri = mongoUrl.toString();
  let connected = false;

  try {
    await mongoose.connect(isolatedUri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ User }, { Track }, { DJLounge }, { Interaction }, { recommendationService }] = await Promise.all([
      import('../src/models/User.js'), import('../src/models/Track.js'), import('../src/models/DJLounge.js'),
      import('../src/models/Interaction.js'), import('../src/services/recommendationService.js'),
    ]);
    const requester = await User.create({ email: `${crypto.randomUUID()}@example.invalid`, displayName: 'Requester', passwordHash: 'test-only-hash', role: 'Listener' });
    const peers = await User.create([
      { email: `${crypto.randomUUID()}@example.invalid`, displayName: 'Peer A', passwordHash: 'test-only-hash', role: 'Listener' },
      { email: `${crypto.randomUUID()}@example.invalid`, displayName: 'Peer B', passwordHash: 'test-only-hash', role: 'Listener' },
    ]);
    await Track.create([
      { trackId: 't_9001', title: 'Shared Seed', artist: 'Test Artist', durationSeconds: 100, acoustic: { bpm: 120, camelotKey: '8A', energy: 0.6, valence: 0.6 }, timeline: [] },
      { trackId: 't_9002', title: 'Co Listener Pick', artist: 'Test Artist', durationSeconds: 100, acoustic: { bpm: 124, camelotKey: '9A', energy: 0.65, valence: 0.65 }, timeline: [] },
      { trackId: 't_9003', title: 'Co Listener Side A', artist: 'Test Artist', durationSeconds: 100, acoustic: { bpm: 126, camelotKey: '9A', energy: 0.66, valence: 0.64 }, timeline: [] },
      { trackId: 't_9004', title: 'Co Listener Side B', artist: 'Test Artist', durationSeconds: 100, acoustic: { bpm: 127, camelotKey: '9A', energy: 0.67, valence: 0.63 }, timeline: [] },
    ]);
    await DJLounge.create({
      loungeId: 'lg_900000000002', inviteCode: 'SP-8X2L', hostUserId: requester._id, vibeProfile: 'Test',
      queue: ['t_9001'], currentTrackId: 't_9001', participantIds: [requester._id, ...peers.map((peer) => peer._id)], status: 'live',
      settings: { maxParticipants: 10, bpmTolerancePct: 8, soundclashEnabled: false, aiVerbosity: 'normal' },
    });

    await recommendationService.recordInteraction({ userId: String(requester._id), trackId: 't_9001', playedSeconds: 100, completed: true, liked: true, loungeId: 'lg_900000000002' });
    for (const peer of peers) {
      await recommendationService.recordInteraction({ userId: String(peer._id), trackId: 't_9001', playedSeconds: 100, completed: true, liked: true, loungeId: 'lg_900000000002' });
      await recommendationService.recordInteraction({ userId: String(peer._id), trackId: 't_9002', playedSeconds: 100, completed: true, liked: true });
      await recommendationService.recordInteraction({ userId: String(peer._id), trackId: String(peer._id) === String(peers[0]._id) ? 't_9003' : 't_9004', playedSeconds: 100, completed: true, liked: true });
    }

    const result = await recommendationService.recommendForUser(String(requester._id), 5);
    expect(result.strategy).toBe('hybrid');
    expect(result.items[0]).toMatchObject({ trackId: 't_9002', reason: { code: 'HYBRID_SIGNAL' } });
    expect(await Interaction.countDocuments({ userId: requester._id, source: 'self_reported' })).toBe(1);
    const stored = await Interaction.findOne({ userId: requester._id, loungeId: 'lg_900000000002' }).lean();
    expect(stored.coListenedWith.map(String)).toEqual(expect.arrayContaining(peers.map((peer) => String(peer._id))));
    expect(JSON.stringify(result)).not.toContain(String(peers[0]._id));
  } finally {
    if (connected) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  }
}, 20000);
