import { createChatService } from '../src/services/chatService.js';
import { createRoomSentimentService } from '../src/services/roomSentimentService.js';
import { createMemoryRateLimiter } from './support/memoryRateLimiter.js';

const loungeA = 'lg_123456789abc';
const loungeB = 'lg_223456789abc';
const userA = '507f1f77bcf86cd799439011';
const userB = '507f1f77bcf86cd799439012';
const requestId = '8c5d4a7b-9a39-4e9a-a22d-a9c21077a451';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function memoryRepository() {
  const messages = [];
  return {
    messages,
    failBeforeWrite: false,
    async findChatMessageByClientMessageId(loungeId, userId, clientMessageId) {
      return messages.find((message) => message.loungeId === loungeId && String(message.userId) === String(userId) && message.clientMessageId === clientMessageId) ?? null;
    },
    async persistChatMessage(message) {
      if (this.failBeforeWrite) throw new Error('simulated write failure');
      const existing = message.clientMessageId
        ? await this.findChatMessageByClientMessageId(message.loungeId, message.userId, message.clientMessageId)
        : messages.find((row) => row.messageId === message.messageId);
      if (existing) return { message: structuredClone(existing), inserted: false };
      const saved = structuredClone(message);
      messages.push(saved);
      return { message: structuredClone(saved), inserted: true };
    },
    async listRecentChatMessages(loungeId, limit) {
      return messages.filter((message) => message.loungeId === loungeId)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || a.messageId.localeCompare(b.messageId))
        .slice(-limit);
    },
    async listChatSentimentMessagesSince(loungeId, since) {
      return messages.filter((message) => message.loungeId === loungeId && new Date(message.createdAt) >= since);
    },
  };
}

test('send resolves only after the durable repository write completes', async () => {
  const repository = memoryRepository();
  const writeEntered = deferred();
  const allowWrite = deferred();
  const persist = repository.persistChatMessage.bind(repository);
  repository.persistChatMessage = async (message) => {
    writeEntered.resolve();
    await allowWrite.promise;
    return persist(message);
  };
  const service = createChatService({ repository, sentimentService: createRoomSentimentService(), rateLimiter: createMemoryRateLimiter() });
  let resolved = false;
  const send = service.send({ loungeId: loungeA, user: { id: userA }, body: 'Amazing set', clientMessageId: requestId }).then((result) => {
    resolved = true;
    return result;
  });

  await writeEntered.promise;
  expect(resolved).toBe(false);
  expect(repository.messages).toHaveLength(0);
  allowWrite.resolve();
  const result = await send;
  expect(resolved).toBe(true);
  expect(repository.messages).toHaveLength(1);
  expect(result.inserted).toBe(true);
});

test('persistence failure is explicit, leaves no accepted history/sentiment, and a reconstructed service can retry', async () => {
  const repository = memoryRepository();
  repository.failBeforeWrite = true;
  const sentimentService = createRoomSentimentService();
  const rateLimiter = createMemoryRateLimiter();
  const serviceBeforeFailure = createChatService({ repository, sentimentService, rateLimiter });

  await expect(serviceBeforeFailure.send({ loungeId: loungeA, user: { id: userA }, body: 'Good music', clientMessageId: requestId }))
    .rejects.toMatchObject({ status: 503, code: 'CHAT_PERSISTENCE_UNAVAILABLE' });
  expect(repository.messages).toHaveLength(0);
  expect(sentimentService.snapshot(loungeA)).toMatchObject({ sampleSize: 0, rollingScore: 0.5 });

  repository.failBeforeWrite = false;
  const serviceAfterReconstruction = createChatService({ repository, sentimentService: createRoomSentimentService(), rateLimiter });
  const accepted = await serviceAfterReconstruction.send({ loungeId: loungeA, user: { id: userA }, body: 'Good music', clientMessageId: requestId });
  expect(accepted.inserted).toBe(true);
  expect(await createChatService({ repository, sentimentService: createRoomSentimentService() }).history(loungeA)).toHaveLength(1);
});

test('client retries reuse one durable message identity and conflicting idempotency payloads are rejected', async () => {
  const repository = memoryRepository();
  const sentimentService = createRoomSentimentService();
  const rateLimiter = createMemoryRateLimiter();
  const service = createChatService({ repository, sentimentService, rateLimiter });
  const first = await service.send({ loungeId: loungeA, user: { id: userA }, body: 'Run it back', clientMessageId: requestId });
  expect(rateLimiter.calls).toBe(1);
  const retry = await service.send({ loungeId: loungeA, user: { id: userA }, body: 'Run it back', clientMessageId: requestId });

  expect(retry.inserted).toBe(false);
  expect(rateLimiter.calls).toBe(1);
  expect(retry.message.messageId).toBe(first.message.messageId);
  expect(repository.messages).toHaveLength(1);
  expect(sentimentService.snapshot(loungeA)).toMatchObject({ sampleSize: 1 });
  await expect(service.send({ loungeId: loungeA, user: { id: userA }, body: 'Different text', clientMessageId: requestId }))
    .rejects.toMatchObject({ status: 409, code: 'CHAT_IDEMPOTENCY_CONFLICT' });
});

test('messages remain chronological and isolated by Lounge and user', async () => {
  let timestamp = 1_800_000_000_000;
  const repository = memoryRepository();
  const service = createChatService({ repository, sentimentService: createRoomSentimentService(), rateLimiter: createMemoryRateLimiter({ now: () => timestamp }), now: () => timestamp++ });

  await Promise.all([
    service.send({ loungeId: loungeA, user: { id: userA }, body: 'first' }),
    service.send({ loungeId: loungeA, user: { id: userB }, body: 'second' }),
    service.send({ loungeId: loungeB, user: { id: userA }, body: 'other room' }),
  ]);
  expect((await service.history(loungeA)).map((message) => message.body)).toEqual(['first', 'second']);
  expect((await service.history(loungeA)).map((message) => message.userId)).toEqual([userA, userB]);
  expect((await service.history(loungeB)).map((message) => message.body)).toEqual(['other room']);
});

test('messages sent in the same clock tick retain their serialized history order', async () => {
  const repository = memoryRepository();
  const service = createChatService({
    repository,
    sentimentService: createRoomSentimentService(),
    rateLimiter: createMemoryRateLimiter(),
    now: () => 1_800_000_000_000,
  });

  await service.send({ loungeId: loungeA, user: { id: userA }, body: 'first' });
  await service.send({ loungeId: loungeA, user: { id: userA }, body: 'second' });

  expect((await service.history(loungeA)).map((message) => message.body)).toEqual(['first', 'second']);
});

test('sentiment processing failure does not undo or hide a persisted message', async () => {
  const repository = memoryRepository();
  const sentimentService = { record() { throw new Error('simulated sentiment failure'); }, snapshot() { throw new Error('simulated sentiment outage'); } };
  const service = createChatService({ repository, sentimentService, rateLimiter: createMemoryRateLimiter() });
  const result = await service.send({ loungeId: loungeA, user: { id: userA }, body: 'Good groove', clientMessageId: requestId });

  expect(result.inserted).toBe(true);
  expect(result.sentiment).toBeNull();
  expect(repository.messages).toHaveLength(1);
  expect(await service.history(loungeA)).toHaveLength(1);
});

test('sentiment rebuild replaces process-local state without counting duplicate events twice', async () => {
  const repository = memoryRepository();
  const rateLimiter = createMemoryRateLimiter();
  const service = createChatService({ repository, sentimentService: createRoomSentimentService(), rateLimiter });
  await service.send({ loungeId: loungeA, user: { id: userA }, body: 'amazing', clientMessageId: requestId });
  const restartedService = createChatService({ repository, sentimentService: createRoomSentimentService(), rateLimiter });

  await expect(restartedService.sentiment(loungeA)).resolves.toMatchObject({ sampleSize: 1, rollingScore: 1 });
  await restartedService.sentiment(loungeA);
  await restartedService.send({ loungeId: loungeA, user: { id: userA }, body: 'amazing', clientMessageId: requestId });

  expect(await restartedService.sentiment(loungeA)).toMatchObject({ sampleSize: 1, rollingScore: 1 });
});
