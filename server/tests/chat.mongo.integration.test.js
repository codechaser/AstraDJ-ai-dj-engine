import { createIsolatedMongoTestDatabase, dropIsolatedMongoTestDatabase } from './mongoTestDatabase.js';

const configuredMongoUri = process.env.MONGODB_TEST_URI;
const liveTest = configuredMongoUri ? test : test.skip;

async function createLiveLounge(DJLounge, loungeId, hostUserId) {
  await DJLounge.create({
    loungeId,
    inviteCode: 'SP-9X2L',
    hostUserId,
    vibeProfile: 'Chat delivery test',
    queue: [],
    status: 'live',
    participantIds: [hostUserId],
    settings: { maxParticipants: 10, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' },
  });
}

liveTest('chat acknowledgement follows Mongo persistence and history survives service reconstruction', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri: isolatedUri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'chat');
  let connected = false;
  try {
    await mongoose.connect(isolatedUri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ queueRepository }, { createChatService }, { createRoomSentimentService }, { ChatMessage }, { DJLounge }] = await Promise.all([
      import('../src/services/queueRepository.js'), import('../src/services/chatService.js'),
      import('../src/services/roomSentimentService.js'), import('../src/models/ChatMessage.js'), import('../src/models/DJLounge.js'),
    ]);
    await ChatMessage.init();
    const loungeId = 'lg_123456789abc';
    const userId = new mongoose.Types.ObjectId();
    await createLiveLounge(DJLounge, loungeId, userId);
    const clientMessageId = 'e54eb334-2b10-4dc1-9e9d-9ccf01713452';
    const sentiment = createRoomSentimentService();
    const firstService = createChatService({ repository: queueRepository, sentimentService: sentiment });
    const { message } = await firstService.send({
      loungeId, user: { id: String(userId) }, body: 'This Mongo-backed message is amazing', clientMessageId,
    });

    // send() has resolved, so a successful acknowledgement may now be sent.
    expect(await ChatMessage.countDocuments({ loungeId })).toBe(1);
    expect(await ChatMessage.findOne({ loungeId, clientMessageId }).lean()).toMatchObject({
      messageId: message.messageId, userId, body: message.body, sentimentBucket: 'positive',
    });

    // A new service has no in-memory state; durable history and sentiment must recover.
    const afterRestart = createChatService({ repository: queueRepository, sentimentService: createRoomSentimentService() });
    expect(await afterRestart.history(loungeId, 10)).toMatchObject([
      { messageId: message.messageId, userId: String(userId), body: message.body, sentimentBucket: 'positive' },
    ]);
    expect(await afterRestart.sentiment(loungeId)).toMatchObject({ sampleSize: 1, rollingScore: 1 });
    const retry = await afterRestart.send({ loungeId, user: { id: String(userId) }, body: message.body, clientMessageId });
    expect(retry.inserted).toBe(false);
    expect(retry.message.messageId).toBe(message.messageId);
    expect(await ChatMessage.countDocuments({ loungeId })).toBe(1);
  } finally {
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 15000);

liveTest('Mongo write rejection is not acknowledged and the same client request can retry', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri: isolatedUri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'chat');
  let connected = false;
  try {
    await mongoose.connect(isolatedUri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ queueRepository }, { createChatService }, { createRoomSentimentService }, { ChatMessage }, { DJLounge }] = await Promise.all([
      import('../src/services/queueRepository.js'), import('../src/services/chatService.js'),
      import('../src/services/roomSentimentService.js'), import('../src/models/ChatMessage.js'), import('../src/models/DJLounge.js'),
    ]);
    const collectionName = ChatMessage.collection.collectionName;
    await mongoose.connection.db.createCollection(collectionName, {
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['body'],
          properties: { body: { enum: ['allowed'] } },
        },
      },
    });
    await ChatMessage.init();
    const loungeId = 'lg_123456789abc';
    const userId = new mongoose.Types.ObjectId();
    await createLiveLounge(DJLounge, loungeId, userId);
    const clientMessageId = 'ccfb1221-a039-4e88-bf8d-3986e8d0d821';
    const service = createChatService({ repository: queueRepository, sentimentService: createRoomSentimentService() });

    await expect(service.send({
      loungeId, user: { id: String(userId) }, body: 'Mongo rejects this write', clientMessageId,
    })).rejects.toMatchObject({ status: 503, code: 'CHAT_PERSISTENCE_UNAVAILABLE' });
    expect(await ChatMessage.countDocuments({ loungeId })).toBe(0);

    await mongoose.connection.db.command({ collMod: collectionName, validator: {} });
    const retry = await service.send({
      loungeId, user: { id: String(userId) }, body: 'Mongo rejects this write', clientMessageId,
    });
    expect(retry.inserted).toBe(true);
    expect(await ChatMessage.countDocuments({ loungeId, clientMessageId })).toBe(1);
  } finally {
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 15000);

liveTest('concurrent service retries share one Mongo message identity', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri: isolatedUri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'chat');
  let connected = false;
  try {
    await mongoose.connect(isolatedUri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ queueRepository }, { createChatService }, { createRoomSentimentService }, { ChatMessage }, { DJLounge }] = await Promise.all([
      import('../src/services/queueRepository.js'), import('../src/services/chatService.js'),
      import('../src/services/roomSentimentService.js'), import('../src/models/ChatMessage.js'), import('../src/models/DJLounge.js'),
    ]);
    await ChatMessage.init();
    const loungeId = 'lg_123456789abc';
    const userId = new mongoose.Types.ObjectId();
    await createLiveLounge(DJLounge, loungeId, userId);
    const clientMessageId = 'd1e38821-29dc-469f-8027-1fd14d0fc056';
    const services = [0, 1].map(() => createChatService({ repository: queueRepository, sentimentService: createRoomSentimentService() }));
    const results = await Promise.all(services.map((service) => service.send({
      loungeId, user: { id: String(userId) }, body: 'One stable retry identity', clientMessageId,
    })));

    expect(results.map(({ message }) => message.messageId).every((id) => id === results[0].message.messageId)).toBe(true);
    expect(results.filter(({ inserted }) => inserted)).toHaveLength(1);
    expect(await ChatMessage.countDocuments({ loungeId, userId, clientMessageId })).toBe(1);
  } finally {
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 15000);

liveTest('a committed message survives a lost acknowledgement and a client retry after service reconstruction', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri: isolatedUri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'chat');
  let connected = false;
  try {
    await mongoose.connect(isolatedUri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ queueRepository }, { createChatService }, { createRoomSentimentService }, { ChatMessage }, { DJLounge }] = await Promise.all([
      import('../src/services/queueRepository.js'), import('../src/services/chatService.js'),
      import('../src/services/roomSentimentService.js'), import('../src/models/ChatMessage.js'), import('../src/models/DJLounge.js'),
    ]);
    await ChatMessage.init();
    const loungeId = 'lg_123456789abc';
    const userId = new mongoose.Types.ObjectId();
    await createLiveLounge(DJLounge, loungeId, userId);
    const clientMessageId = '45f6f172-aa6f-40d6-a20a-ce16d4f79955';
    let simulateLostAck = true;
    const repository = {
      ...queueRepository,
      async persistChatMessage(message) {
        const result = await queueRepository.persistChatMessage(message);
        if (simulateLostAck) {
          simulateLostAck = false;
          throw new Error('simulated process loss after Mongo commit and before acknowledgement');
        }
        return result;
      },
    };
    const interrupted = createChatService({ repository, sentimentService: createRoomSentimentService() });
    await expect(interrupted.send({ loungeId, user: { id: String(userId) }, body: 'Commit before lost ack', clientMessageId }))
      .rejects.toMatchObject({ status: 503, code: 'CHAT_PERSISTENCE_UNAVAILABLE' });
    const committed = await ChatMessage.findOne({ loungeId, clientMessageId }).lean();
    expect(committed).not.toBeNull();

    const recovered = createChatService({ repository: queueRepository, sentimentService: createRoomSentimentService() });
    const retry = await recovered.send({ loungeId, user: { id: String(userId) }, body: 'Commit before lost ack', clientMessageId });
    expect(retry.inserted).toBe(false);
    expect(retry.message.messageId).toBe(committed.messageId);
    expect(await ChatMessage.countDocuments({ loungeId, clientMessageId })).toBe(1);
  } finally {
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 15000);
