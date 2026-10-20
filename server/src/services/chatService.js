import crypto from 'node:crypto';
import { ApiError } from '../utils/ApiError.js';
import { bucketSentiment, sentimentScoreForBucket } from './roomSentimentService.js';

const MAX_MESSAGE_LENGTH = 500;
const RATE_LIMIT_COUNT = 5;
const RATE_LIMIT_WINDOW_MS = 10_000;

export function sanitizeMessage(value) {
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', 'body must be a text message');
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/<[^>]*>/g, '').trim();
  const length = [...normalized].length;
  if (!normalized || length > MAX_MESSAGE_LENGTH) {
    throw new ApiError(400, 'VALIDATION_ERROR', `body must contain 1-${MAX_MESSAGE_LENGTH} characters after sanitization`);
  }
  return normalized;
}

export function createChatService({ repository, sentimentService, now = () => Date.now(), rateLimitCount = RATE_LIMIT_COUNT, rateLimitWindowMs = RATE_LIMIT_WINDOW_MS, flushBatchSize = 20, flushIntervalMs = 1000 } = {}) {
  const pendingByLounge = new Map();
  const timers = new Map();
  const recentByUser = new Map();
  const locks = new Map();

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

  function enforceRateLimit(loungeId, userId) {
    const key = `${loungeId}:${userId}`;
    const cutoff = now() - rateLimitWindowMs;
    const recent = (recentByUser.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= rateLimitCount) throw new ApiError(429, 'CHAT_RATE_LIMITED', 'Too many messages; wait before sending another');
    recent.push(now());
    recentByUser.set(key, recent);
  }

  async function flush(loungeId) {
    const timer = timers.get(loungeId);
    if (timer) { clearTimeout(timer); timers.delete(loungeId); }
    const pending = pendingByLounge.get(loungeId) ?? [];
    if (!pending.length) return;
    const batch = [...pending];
    try { await repository.appendChatMessages(batch); }
    catch (error) { scheduleFlush(loungeId); throw error; }
    pending.splice(0, batch.length);
    if (!pending.length) pendingByLounge.delete(loungeId);
  }

  function scheduleFlush(loungeId) {
    if (timers.has(loungeId)) return;
    const timer = setTimeout(() => {
      timers.delete(loungeId);
      void serialized(loungeId, () => flush(loungeId)).catch(() => scheduleFlush(loungeId));
    }, flushIntervalMs);
    timer.unref?.();
    timers.set(loungeId, timer);
  }

  return {
    async send({ loungeId, user, body }) {
      const cleanBody = sanitizeMessage(body);
      return serialized(loungeId, async () => {
        enforceRateLimit(loungeId, user.id);
        const tsSeconds = Math.floor(now() / 1000);
        const sentimentBucket = bucketSentiment(cleanBody);
        const message = {
          messageId: crypto.randomUUID(),
          userId: user.id,
          body: cleanBody,
          msgType: 'chat',
          sentimentBucket,
          sentimentScore: sentimentScoreForBucket(sentimentBucket),
          tsSeconds,
          createdAt: new Date(tsSeconds * 1000),
        };
        const pending = pendingByLounge.get(loungeId) ?? [];
        pending.push({ ...message, loungeId });
        pendingByLounge.set(loungeId, pending);
        const sentiment = sentimentService.record(loungeId, message);
        if (pending.length >= flushBatchSize) {
          // An accepted message stays available in the in-memory history and is retried
          // after a transient store failure rather than being rejected after scoring.
          try { await flush(loungeId); } catch { /* flush() schedules a retry */ }
        }
        else scheduleFlush(loungeId);
        return { message, sentiment };
      });
    },

    async history(loungeId, limit = 50) {
      return serialized(loungeId, async () => {
        const persisted = await repository.listRecentChatMessages(loungeId, limit);
        const pending = (pendingByLounge.get(loungeId) ?? []).map(({ loungeId: _loungeId, ...message }) => message);
        const combined = [...persisted, ...pending]
          .sort((a, b) => a.tsSeconds - b.tsSeconds || a.messageId.localeCompare(b.messageId));
        return combined.slice(-limit).map(({ messageId, userId, body, sentimentBucket, tsSeconds }) => ({ messageId, userId: String(userId), body, sentimentBucket, tsSeconds }));
      });
    },

    async flush(loungeId) { return serialized(loungeId, () => flush(loungeId)); },
    async flushAll() {
      for (const loungeId of new Set([...pendingByLounge.keys(), ...timers.keys()])) await this.flush(loungeId);
    },
  };
}
