import { createIsolatedMongoTestDatabase, dropIsolatedMongoTestDatabase } from './mongoTestDatabase.js';

const configuredMongoUri = process.env.MONGODB_TEST_URI;
const liveTest = configuredMongoUri ? test : test.skip;

liveTest('ChatMessage history writes and reads through MongoDB in an isolated temporary database', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri: isolatedUri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'chat');
  let connected = false;
  let chatService;

  try {
    await mongoose.connect(isolatedUri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ queueRepository }, { createChatService }, { createRoomSentimentService }, { ChatMessage }] = await Promise.all([
      import('../src/services/queueRepository.js'), import('../src/services/chatService.js'),
      import('../src/services/roomSentimentService.js'), import('../src/models/ChatMessage.js'),
    ]);
    const userId = new mongoose.Types.ObjectId();
    chatService = createChatService({ repository: queueRepository, sentimentService: createRoomSentimentService() });
    const { message } = await chatService.send({
      loungeId: 'lg_123456789abc', user: { id: String(userId) }, body: 'This Mongo-backed message is amazing',
    });
    await chatService.flush('lg_123456789abc');
    const history = await chatService.history('lg_123456789abc', 10);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ messageId: message.messageId, userId: String(userId), body: message.body, sentimentBucket: 'positive' });
    expect(await ChatMessage.countDocuments({ loungeId: 'lg_123456789abc' })).toBe(1);
  } finally {
    if (connected) {
      try { await chatService?.flushAll(); }
      finally { await dropIsolatedMongoTestDatabase(mongoose, databaseName); }
    }
  }
}, 15000);
