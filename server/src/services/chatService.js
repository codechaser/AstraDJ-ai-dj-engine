import crypto from 'node:crypto';
import { ApiError } from '../utils/ApiError.js';
import { bucketSentiment, sentimentScoreForBucket } from './roomSentimentService.js';
import { assertRateLimit, distributedRateLimiter } from './distributedRateLimiter.js';
import { rateLimitPolicies } from '../config/rateLimitPolicy.js';

const MAX_MESSAGE_LENGTH = 500;
const UUID_PATTERN = /^[a-f0-9-]{36}$/i;

export function sanitizeMessage(value) {
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', 'body must be a text message');
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/<[^>]*>/g, '').trim();
  const length = [...normalized].length;
  if (!normalized || length > MAX_MESSAGE_LENGTH) {
    throw new ApiError(400, 'VALIDATION_ERROR', `body must contain 1-${MAX_MESSAGE_LENGTH} characters after sanitization`);
  }
  return normalized;
}

export function validateClientMessageId(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'clientMessageId must be a UUID');
  }
  return value;
}

export function createChatService({ repository, sentimentService, now = () => Date.now(), rateLimiter = distributedRateLimiter, rateLimitCount = rateLimitPolicies.chat.limit, rateLimitWindowMs = rateLimitPolicies.chat.windowMs } = {}) {
  const locks = new Map();
  let lastMessageTimestamp = 0;

  async function serialized(loungeId, operation) {
    const previous = locks.get(loungeId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const chain = previous.then(() => gate);
    locks.set(loungeId, chain);
    await previous;
    try { return await operation(); }
    finally { release(); if (locks.get(loungeId) === chain) locks.delete(loungeId); }
  }

  function sentimentSnapshot(loungeId) {
    try { return sentimentService?.snapshot?.(loungeId) ?? null; }
    catch { return null; }
  }

  async function currentSentiment(loungeId, message, inserted) {
    try {
      if (typeof repository?.listChatSentimentMessagesSince === 'function' && typeof sentimentService?.replace === 'function') {
        const since = new Date(now() - (sentimentService.windowSeconds ?? 300) * 1000);
        const messages = await repository.listChatSentimentMessagesSince(loungeId, since);
        return sentimentService.replace(loungeId, messages);
      }
      if (inserted) return sentimentService?.record?.(loungeId, message) ?? null;
      return sentimentSnapshot(loungeId);
    } catch {
      return sentimentSnapshot(loungeId);
    }
  }

  async function ensureDelivery(message) {
    if (typeof repository?.ensureChatDeliveryEvent !== 'function') return message;
    try {
      const deliveryEventSeq = await repository.ensureChatDeliveryEvent(message);
      await repository.markChatMessageDelivered(message.loungeId, message.messageId, deliveryEventSeq);
      return { ...message, deliveryEventSeq };
    } catch {
      throw new ApiError(503, 'CHAT_DELIVERY_UNAVAILABLE', 'The message is stored but Lounge delivery is pending; retry with the same clientMessageId');
    }
  }

  async function persist(message) {
    try {
      if (typeof repository?.persistChatMessage !== 'function') throw new Error('Durable chat repository is unavailable');
      return await repository.persistChatMessage(message);
    } catch {
      throw new ApiError(503, 'CHAT_PERSISTENCE_UNAVAILABLE', 'The message could not be safely stored; retry with the same clientMessageId');
    }
  }

  async function findExisting(loungeId, userId, clientMessageId) {
    try { return await repository.findChatMessageByClientMessageId(loungeId, userId, clientMessageId); }
    catch {
      throw new ApiError(503, 'CHAT_PERSISTENCE_UNAVAILABLE', 'The message could not be safely checked; retry with the same clientMessageId');
    }
  }

  async function repairPendingDelivery(loungeId) {
    if (typeof repository?.listChatMessagesNeedingDelivery !== 'function') return 0;
    const pending = await repository.listChatMessagesNeedingDelivery(loungeId, 50);
    for (const message of pending) {
      const delivery = await ensureDelivery(message);
      await repository.markChatMessageDelivered(loungeId, message.messageId, delivery.deliveryEventSeq);
    }
    return pending.length;
  }

  return {
    async send({ loungeId, user, body, clientMessageId }) {
      const cleanBody = sanitizeMessage(body);
      const idempotencyKey = validateClientMessageId(clientMessageId);
      return serialized(loungeId, async () => {
        const timestamp = now();

        // Look up retries before rate limiting. This lets a client safely retry
        // after losing an acknowledgement without recording or scoring twice.
        if (idempotencyKey) {
          const existing = await findExisting(loungeId, user.id, idempotencyKey);
          if (existing) {
            if (existing.body !== cleanBody) throw new ApiError(409, 'CHAT_IDEMPOTENCY_CONFLICT', 'clientMessageId was already used for a different message');
            const delivered = await ensureDelivery(existing);
            const sentiment = await currentSentiment(loungeId, delivered, false);
            return { message: delivered, sentiment, inserted: false };
          }
        }

        await assertRateLimit(rateLimiter, {
          ...rateLimitPolicies.chat,
          limit: rateLimitCount,
          windowMs: rateLimitWindowMs,
        }, [loungeId, String(user.id)]);
        const messageTimestamp = Math.max(timestamp, lastMessageTimestamp + 1);
        lastMessageTimestamp = messageTimestamp;
        const sentimentBucket = bucketSentiment(cleanBody);
        const message = {
          messageId: crypto.randomUUID(),
          ...(idempotencyKey ? { clientMessageId: idempotencyKey } : {}),
          loungeId,
          userId: user.id,
          body: cleanBody,
          msgType: 'chat',
          sentimentBucket,
          sentimentScore: sentimentScoreForBucket(sentimentBucket),
          tsSeconds: Math.floor(messageTimestamp / 1000),
          createdAt: new Date(messageTimestamp),
        };

        const persisted = await persist(message);
        const savedMessage = persisted?.message ?? persisted;
        if (!savedMessage?.messageId) throw new ApiError(503, 'CHAT_PERSISTENCE_UNAVAILABLE', 'The message could not be safely stored; retry with the same clientMessageId');
        if (idempotencyKey && savedMessage.body !== cleanBody) {
          throw new ApiError(409, 'CHAT_IDEMPOTENCY_CONFLICT', 'clientMessageId was already used for a different message');
        }
        const delivered = await ensureDelivery(savedMessage);
        if (persisted?.inserted === false) {
          const sentiment = await currentSentiment(loungeId, delivered, false);
          return { message: delivered, sentiment, inserted: false };
        }

        // Durability is the acceptance boundary for chat; quota is charged
        // before writing, while idempotent retries are resolved above.
        const sentiment = await currentSentiment(loungeId, delivered, true);
        return { message: delivered, sentiment, inserted: true };
      });
    },

    async history(loungeId, limit = 50) {
      return serialized(loungeId, async () => {
        const persisted = await repository.listRecentChatMessages(loungeId, limit);
        return persisted.map(({ messageId, userId, body, sentimentBucket, tsSeconds }) => ({
          messageId, userId: String(userId), body, sentimentBucket, tsSeconds,
        }));
      });
    },

    sentiment(loungeId) { return currentSentiment(loungeId, null, false); },
    repairPendingDelivery,
    async flush(loungeId) { if (loungeId) await repairPendingDelivery(loungeId); },
    async flushAll() {},
  };
}
