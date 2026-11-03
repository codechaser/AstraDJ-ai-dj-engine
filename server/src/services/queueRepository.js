import { performance } from 'node:perf_hooks';
import { DJLounge } from '../models/DJLounge.js';
import { QueueEvent } from '../models/QueueEvent.js';
import { ChatMessage } from '../models/ChatMessage.js';
import { Track } from '../models/Track.js';
import { User } from '../models/User.js';
import { applyCoordinationEvent, createCoordinationState, deserializeCoordinationState, serializeCoordinationState } from './coordinationState.js';
import mongoose from 'mongoose';
import { recordAcceptanceDuration } from './queueAcceptanceTrace.js';

const MAX_LOUNGE_OUTBOX_EVENTS = 100;
const MAX_COORDINATION_BYTES = 8 * 1024 * 1024;
export const PARTICIPANT_LEASE_TTL_MS = 60_000;
export const GATEWAY_PRESENCE_TTL_MS = 60_000;

function activeParticipantUserIds(now) {
  const activeLeases = {
    $filter: {
      input: { $ifNull: ['$activeParticipantLeases', []] },
      as: 'lease',
      cond: { $gt: ['$$lease.expiresAt', now] },
    },
  };
  return { $setUnion: [{ $map: { input: activeLeases, as: 'lease', in: '$$lease.userId' } }, []] };
}

function toObjectId(userId) {
  if (userId instanceof mongoose.Types.ObjectId) return userId;
  if (!mongoose.Types.ObjectId.isValid(userId)) throw new TypeError('Lounge participant user ID must be a valid ObjectId');
  return new mongoose.Types.ObjectId(userId);
}

function activeGatewayPresenceCount(userObjectId) {
  return { $size: { $filter: {
    input: { $ifNull: ['$gatewayPresences', []] },
    as: 'presence',
    cond: { $and: [
      { $eq: ['$$presence.userId', userObjectId] },
      { $gt: ['$$presence.expiresAt', '$$NOW'] },
    ] },
  } } };
}

function validateGatewayPresence({ gatewayId, userId, generation, socketCount, ttlMs }) {
  if (typeof gatewayId !== 'string' || !gatewayId || gatewayId.length > 200) throw new TypeError('Gateway presence ID is invalid');
  if (typeof generation !== 'string' || !generation || generation.length > 200) throw new TypeError('Gateway presence generation is invalid');
  if (!Number.isInteger(socketCount) || socketCount < 1) throw new TypeError('Gateway presence socket count is invalid');
  if (!Number.isInteger(ttlMs) || ttlMs < 100 || ttlMs > 10 * 60_000) throw new TypeError('Gateway presence TTL is invalid');
  return toObjectId(userId);
}

function sameEvent(left, right) {
  return left?.loungeId === right.loungeId && left?.seq === right.seq && left?.type === right.type
    && String(left?.actorUserId ?? '') === String(right.actorUserId ?? '')
    && JSON.stringify(left?.payload) === JSON.stringify(right.payload)
    && new Date(left?.createdAt).getTime() === new Date(right.createdAt).getTime();
}

export const queueRepository = {
  findLoungeByInvite(inviteCode) {
    return DJLounge.findOne({ inviteCode: inviteCode.toUpperCase(), status: { $ne: 'ended' } }).lean();
  },
  findLoungeById(loungeId) {
    return DJLounge.findOne({ loungeId }).lean();
  },
  async joinLounge(lounge, userId, { leaseId, now = new Date(), expiresAt = new Date(now.getTime() + PARTICIPANT_LEASE_TTL_MS) } = {}) {
    if (typeof leaseId !== 'string' || !leaseId || leaseId.length > 200) throw new TypeError('Lounge participant lease ID is invalid');
    const userObjectId = toObjectId(userId);
    const activeUserIds = activeParticipantUserIds(now);
    return DJLounge.findOneAndUpdate({
      loungeId: lounge.loungeId,
      status: { $in: ['scheduled', 'live'] },
      $expr: {
        $or: [
          { $in: [userObjectId, activeUserIds] },
          { $lt: [{ $size: activeUserIds }, '$settings.maxParticipants'] },
        ],
      },
    }, [
      { $set: {
        activeParticipantLeases: {
          $concatArrays: [
            { $filter: {
              input: { $ifNull: ['$activeParticipantLeases', []] },
              as: 'lease',
              cond: { $and: [
                { $gt: ['$$lease.expiresAt', now] },
                { $ne: ['$$lease.leaseId', leaseId] },
              ] },
            } },
            { $literal: [{ userId: userObjectId, leaseId, expiresAt }] },
          ],
        },
        participantIds: { $setUnion: [{ $ifNull: ['$participantIds', []] }, [userObjectId]] },
        status: { $cond: [{ $eq: ['$status', 'scheduled'] }, 'live', '$status'] },
        startedAt: { $cond: [{ $eq: ['$status', 'scheduled'] }, now, '$startedAt'] },
      } },
    ], { new: true }).lean();
  },
  async releaseAdmissionLease(loungeId, leaseId) {
    if (!leaseId) return;
    await DJLounge.updateOne({ loungeId }, { $pull: { activeParticipantLeases: { leaseId } } });
  },
  async renewAdmissionLeases(loungeId, leaseIds, now, expiresAt) {
    const ownLeaseIds = [...new Set(leaseIds)];
    if (!ownLeaseIds.length) return new Set();
    const activeOwnLeases = {
      $filter: {
        input: { $ifNull: ['$activeParticipantLeases', []] },
        as: 'lease',
        cond: { $and: [
          { $gt: ['$$lease.expiresAt', now] },
          { $in: ['$$lease.leaseId', ownLeaseIds] },
        ] },
      },
    };
    await DJLounge.updateOne({ loungeId, status: 'live' }, [{
      $set: {
        activeParticipantLeases: {
          $concatArrays: [
            { $filter: {
              input: { $ifNull: ['$activeParticipantLeases', []] },
              as: 'lease',
              cond: { $and: [
                { $gt: ['$$lease.expiresAt', now] },
                { $not: [{ $in: ['$$lease.leaseId', ownLeaseIds] }] },
              ] },
            } },
            { $map: {
              input: activeOwnLeases,
              as: 'lease',
              in: { $mergeObjects: ['$$lease', { expiresAt }] },
            } },
          ],
        },
      },
    }]);
    const lounge = await DJLounge.findOne({ loungeId }).select('activeParticipantLeases.leaseId').lean();
    return new Set((lounge?.activeParticipantLeases ?? []).map((lease) => lease.leaseId).filter((id) => ownLeaseIds.includes(id)));
  },
  async upsertGatewayPresence(loungeId, presence, ttlMs = GATEWAY_PRESENCE_TTL_MS) {
    const userObjectId = validateGatewayPresence({ ...presence, ttlMs });
    const sameGatewayUser = { $and: [
      { $eq: ['$$presence.gatewayId', { $literal: presence.gatewayId }] },
      { $eq: ['$$presence.userId', { $literal: userObjectId }] },
    ] };
    const storedPresence = { $mergeObjects: [
      { $literal: {
        gatewayId: presence.gatewayId,
        userId: userObjectId,
        generation: presence.generation,
        socketCount: presence.socketCount,
      } },
      { heartbeatAt: '$$NOW', expiresAt: { $add: ['$$NOW', ttlMs] } },
    ] };
    const result = await DJLounge.updateOne({ loungeId, status: 'live' }, [{
      $set: {
        gatewayPresences: { $concatArrays: [
          { $filter: {
            input: { $ifNull: ['$gatewayPresences', []] },
            as: 'presence',
            cond: { $and: [
              { $gt: ['$$presence.expiresAt', '$$NOW'] },
              { $not: [sameGatewayUser] },
            ] },
          } },
          [storedPresence],
        ] },
      },
    }]);
    return result.matchedCount === 1;
  },
  async removeGatewayPresence(loungeId, { gatewayId, userId, generation }) {
    const userObjectId = toObjectId(userId);
    if (typeof gatewayId !== 'string' || !gatewayId || typeof generation !== 'string' || !generation) return false;
    const sameGeneration = { $and: [
      { $eq: ['$$presence.gatewayId', { $literal: gatewayId }] },
      { $eq: ['$$presence.userId', { $literal: userObjectId }] },
      { $eq: ['$$presence.generation', { $literal: generation }] },
    ] };
    const result = await DJLounge.updateOne({ loungeId }, [{
      $set: { gatewayPresences: { $filter: {
        input: { $ifNull: ['$gatewayPresences', []] },
        as: 'presence',
        cond: { $not: [sameGeneration] },
      } } },
    }]);
    return result.modifiedCount === 1;
  },
  async hasActiveGatewayPresence(loungeId, userId) {
    const userObjectId = toObjectId(userId);
    const [lounge] = await DJLounge.aggregate([
      { $match: { loungeId } },
      { $project: { activePresenceCount: activeGatewayPresenceCount(userObjectId) } },
      { $match: { activePresenceCount: { $gt: 0 } } },
      { $limit: 1 },
    ]);
    return Boolean(lounge);
  },
  async listActiveGatewayPresence(loungeId) {
    const rows = await DJLounge.aggregate([
      { $match: { loungeId } },
      { $project: { gatewayPresences: { $filter: {
        input: { $ifNull: ['$gatewayPresences', []] },
        as: 'presence',
        cond: { $gt: ['$$presence.expiresAt', '$$NOW'] },
      } } } },
      { $unwind: '$gatewayPresences' },
      { $group: {
        _id: '$gatewayPresences.userId',
        socketCount: { $sum: '$gatewayPresences.socketCount' },
        gatewayCount: { $sum: 1 },
      } },
    ]);
    if (!rows.length) return [];
    const users = await User.find({ _id: { $in: rows.map(({ _id }) => _id) } }).select('displayName role').lean();
    const usersById = new Map(users.map((user) => [String(user._id), user]));
    return rows.flatMap((row) => {
      const user = usersById.get(String(row._id));
      return user ? [{ userId: String(row._id), displayName: user.displayName, role: user.role, connected: true, socketCount: row.socketCount, gatewayCount: row.gatewayCount }] : [];
    });
  },
  listQueueEvents(loungeId) {
    return this.drainOutbox(loungeId).then(() => QueueEvent.find({ loungeId }).sort({ seq: 1 }).lean());
  },
  async listQueueEventsAfter(loungeId, afterSeq) {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new TypeError('Queue event cursor must be a non-negative safe integer');
    await this.drainOutbox(loungeId);
    return QueueEvent.find({ loungeId, seq: { $gt: afterSeq } }).sort({ seq: 1 }).lean();
  },
  async getCoordination(loungeId) {
    let lounge = await DJLounge.findOne({ loungeId }).lean();
    if (!lounge) return null;
    if (lounge.coordination?.state) return { lounge, coordination: lounge.coordination };
    const events = await QueueEvent.find({ loungeId }).sort({ seq: 1 }).lean();
    const state = createCoordinationState(lounge, events);
    const coordination = { revision: state.revision, state: serializeCoordinationState(state), outbox: [] };
    lounge = await DJLounge.findOneAndUpdate(
      { loungeId, $or: [{ coordination: null }, { coordination: { $exists: false } }] },
      { $set: { coordination } },
      { new: true },
    ).lean() ?? await DJLounge.findOne({ loungeId }).lean();
    return lounge?.coordination?.state ? { lounge, coordination: lounge.coordination } : null;
  },
  async commitCoordination({ loungeId, expectedRevision, state, events, requiredHostPresenceUserId = null, allowEnded = false, acceptanceTrace = null }) {
    // getCoordination already loaded the authoritative snapshot for this
    // mutation. This second read only needs the outbox for size/backpressure
    // accounting; avoid transferring the growing queue snapshot again.
    const outboxReadStarted = acceptanceTrace ? performance.now() : 0;
    const current = await DJLounge.findOne({ loungeId }).select('coordination.outbox').lean();
    if (acceptanceTrace) recordAcceptanceDuration(acceptanceTrace, 'mongoOutboxReadMs', performance.now() - outboxReadStarted);
    if (!current) return { committed: false, reason: 'missing' };
    const outbox = current.coordination?.outbox ?? [];
    if (outbox.length + events.length > MAX_LOUNGE_OUTBOX_EVENTS) {
      await this.drainOutbox(loungeId, acceptanceTrace);
      const refreshStarted = acceptanceTrace ? performance.now() : 0;
      const refreshed = await DJLounge.findOne({ loungeId }).select('coordination.outbox').lean();
      if (acceptanceTrace) recordAcceptanceDuration(acceptanceTrace, 'mongoOutboxRefreshMs', performance.now() - refreshStarted);
      if ((refreshed?.coordination?.outbox?.length ?? 0) + events.length > MAX_LOUNGE_OUTBOX_EVENTS) {
        return { committed: false, reason: 'outbox_full' };
      }
      return this.commitCoordination({ loungeId, expectedRevision, state, events, requiredHostPresenceUserId, allowEnded, acceptanceTrace });
    }
    const committedEvents = events.map((event, index) => ({
      ...event,
      loungeId,
      seq: expectedRevision + index + 1,
      eventId: `${loungeId}:${expectedRevision + index + 1}`,
      createdAt: event.createdAt ?? new Date(),
    }));
    const revision = expectedRevision + committedEvents.length;
    const committedState = serializeCoordinationState({ ...state, revision });
    const coordinationBytes = Buffer.byteLength(JSON.stringify({ revision, state: committedState, outbox: [...outbox, ...committedEvents] }));
    if (coordinationBytes > MAX_COORDINATION_BYTES) return { committed: false, reason: 'state_too_large' };
    const updateFilter = { loungeId, status: allowEnded ? { $in: ['live', 'ended'] } : 'live', 'coordination.revision': expectedRevision, 'coordination.outbox.100': { $exists: false } };
    if (requiredHostPresenceUserId) {
      const hostUserObjectId = toObjectId(requiredHostPresenceUserId);
      updateFilter.hostUserId = hostUserObjectId;
      updateFilter.$expr = { $gt: [activeGatewayPresenceCount(hostUserObjectId), 0] };
    }
    const commitStarted = acceptanceTrace ? performance.now() : 0;
    const updated = await DJLounge.findOneAndUpdate(
      updateFilter,
      {
        $set: {
          'coordination.revision': revision,
          'coordination.state': committedState,
          currentTrackId: committedState.currentTrackId,
          queue: committedState.items.map(({ trackId }) => trackId),
          ...(committedState.pendingSegue ? { pendingSegue: committedState.pendingSegue } : {}),
          soundclash: {
            active: committedState.soundclash.status === 'open',
            candidates: committedState.soundclash.candidateTrackIds,
            votes: committedState.soundclash.votes,
          },
        },
        ...(!committedState.pendingSegue ? { $unset: { pendingSegue: 1 } } : {}),
        ...(committedEvents.length ? { $push: { 'coordination.outbox': { $each: committedEvents } } } : {}),
      },
      { new: true },
    ).select('coordination.revision').lean();
    if (acceptanceTrace) {
      recordAcceptanceDuration(acceptanceTrace, 'mongoRevisionCasMs', performance.now() - commitStarted);
    }
    if (!updated) {
      if (requiredHostPresenceUserId && !await this.hasActiveGatewayPresence(loungeId, requiredHostPresenceUserId)) {
        return { committed: false, reason: 'host_offline' };
      }
      return { committed: false, reason: 'conflict' };
    }
    if (acceptanceTrace) acceptanceTrace.commitAtMonoMs = performance.now();
    await this.drainOutbox(loungeId, acceptanceTrace);
    return { committed: true, events: committedEvents, revision };
  },
  async drainOutbox(loungeId, acceptanceTrace = null) {
    const outboxReadStarted = acceptanceTrace ? performance.now() : 0;
    const lounge = await DJLounge.findOne({ loungeId }).select('coordination.outbox').lean();
    if (acceptanceTrace) recordAcceptanceDuration(acceptanceTrace, 'mongoOutboxDrainReadMs', performance.now() - outboxReadStarted);
    for (const event of lounge?.coordination?.outbox ?? []) {
      const { eventId, ...durableEvent } = event;
      const insertStarted = acceptanceTrace ? performance.now() : 0;
      let existing;
      try {
        existing = await QueueEvent.findOneAndUpdate(
          { loungeId, seq: event.seq },
          { $setOnInsert: durableEvent },
          { upsert: true, new: true },
        ).lean();
      } catch (error) {
        // Concurrent outbox drainers may race to upsert the same (lounge, seq).
        // The unique index chooses the winner; read and verify that row before acking.
        if (error?.code !== 11000) throw error;
        existing = await QueueEvent.findOne({ loungeId, seq: event.seq }).lean();
      }
      if (acceptanceTrace) recordAcceptanceDuration(acceptanceTrace, 'mongoQueueEventUpsertMs', performance.now() - insertStarted);
      if (!sameEvent(existing, durableEvent)) throw new Error(`Queue outbox event conflict at ${loungeId}:${event.seq}`);
      const pullStarted = acceptanceTrace ? performance.now() : 0;
      await DJLounge.updateOne({ loungeId }, { $pull: { 'coordination.outbox': { eventId } } });
      if (acceptanceTrace) recordAcceptanceDuration(acceptanceTrace, 'mongoOutboxPullMs', performance.now() - pullStarted);
      if (acceptanceTrace) acceptanceTrace.outboxEventsDrained = (acceptanceTrace.outboxEventsDrained ?? 0) + 1;
    }
  },
  async getTrack(trackId) {
    return Track.findOne({ trackId }).select('trackId title artist durationSeconds audioAssetUrl acoustic').lean();
  },
  getTracks(trackIds) {
    const ids = [...new Set(trackIds.filter(Boolean))];
    if (!ids.length) return Promise.resolve([]);
    return Track.find({ trackId: { $in: ids } }).select('trackId title artist durationSeconds audioAssetUrl acoustic').lean();
  },
  async setPendingSegue(loungeId, fromTrackId, pendingSegue, { requiredHostPresenceUserId = null } = {}) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const loaded = await this.getCoordination(loungeId);
      if (!loaded || loaded.lounge.status !== 'live' || loaded.lounge.currentTrackId !== fromTrackId) return null;
      const state = deserializeCoordinationState(loaded.coordination.state);
      if (pendingSegue.trackId === fromTrackId || !state.items.some((item) => item.trackId === pendingSegue.trackId)) return null;
      if (state.pendingSegue) {
        return state.pendingSegue.fromTrackId === fromTrackId && state.pendingSegue.trackId === pendingSegue.trackId ? loaded.lounge : null;
      }
      const event = { type: 'segue.prepared', actorUserId: null, payload: pendingSegue, createdAt: pendingSegue.createdAt };
      const next = structuredClone(state);
      applyCoordinationEvent(next, { ...event, seq: state.revision + 1 });
      const committed = await this.commitCoordination({ loungeId, expectedRevision: state.revision, state: next, events: [event], requiredHostPresenceUserId });
      if (committed.committed) return DJLounge.findOne({ loungeId }).lean();
      if (committed.reason !== 'conflict') return null;
    }
    return null;
  },
  async clearPendingSegue(loungeId, fromTrackId) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const loaded = await this.getCoordination(loungeId);
      if (!loaded) return null;
      const state = deserializeCoordinationState(loaded.coordination.state);
      if (state.pendingSegue?.fromTrackId !== fromTrackId) return loaded.lounge;
      const event = { type: 'segue.cancelled', actorUserId: null, payload: { fromTrackId }, createdAt: new Date() };
      const next = structuredClone(state);
      applyCoordinationEvent(next, { ...event, seq: state.revision + 1 });
      const committed = await this.commitCoordination({ loungeId, expectedRevision: state.revision, state: next, events: [event] });
      if (committed.committed) return DJLounge.findOne({ loungeId }).lean();
      if (committed.reason !== 'conflict') return null;
    }
    return null;
  },
  async getTrackMetadata(trackId) {
    return Track.findOne({ trackId }).select('trackId title artist timeline').lean();
  },
  getUser(userId) {
    return User.findById(userId).select('email displayName role preferences.audio.aiDjCommentary').lean();
  },
  appendChatMessages(messages) {
    return ChatMessage.bulkWrite(messages.map((message) => ({
      updateOne: { filter: { messageId: message.messageId }, update: { $setOnInsert: message }, upsert: true },
    })), { ordered: true });
  },
  async findChatMessageByClientMessageId(loungeId, userId, clientMessageId) {
    return ChatMessage.findOne({ loungeId, userId: toObjectId(userId), clientMessageId }).lean();
  },
  findChatMessageByMessageId(loungeId, messageId) {
    return ChatMessage.findOne({ loungeId, messageId }).lean();
  },
  async persistChatMessage(message) {
    const filter = message.clientMessageId
      ? { loungeId: message.loungeId, userId: toObjectId(message.userId), clientMessageId: message.clientMessageId }
      : { messageId: message.messageId };
    try {
      const write = await ChatMessage.updateOne(filter, { $setOnInsert: message }, { upsert: true, runValidators: true });
      const savedMessage = await ChatMessage.findOne(filter).lean();
      if (!savedMessage) throw new Error('Persisted chat message could not be read back');
      return { message: savedMessage, inserted: write.upsertedCount === 1 };
    } catch (error) {
      // Concurrent retries can race the unique idempotency index. Read the
      // winner so both callers return the same durable message identity.
      if (error?.code === 11000 && message.clientMessageId) {
        const existing = await ChatMessage.findOne(filter).lean();
        if (existing) return { message: existing, inserted: false };
      }
      throw error;
    }
  },
  async ensureChatDeliveryEvent(message) {
    const messageId = message.messageId;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const loaded = await this.getCoordination(message.loungeId);
      if (!loaded || loaded.lounge.status !== 'live') throw new Error('Lounge is unavailable for chat delivery');

      const queued = loaded.coordination.outbox?.find((event) => event.type === 'chat.message' && event.payload?.messageId === messageId);
      if (queued) {
        await this.drainOutbox(message.loungeId);
        return queued.seq;
      }
      const existing = await QueueEvent.findOne({ loungeId: message.loungeId, type: 'chat.message', 'payload.messageId': messageId }).lean();
      if (existing) return existing.seq;

      const state = deserializeCoordinationState(loaded.coordination.state);
      const event = {
        type: 'chat.message',
        actorUserId: toObjectId(message.userId),
        payload: {
          messageId,
          userId: String(message.userId),
          body: message.body,
          sentimentBucket: message.sentimentBucket,
          tsSeconds: message.tsSeconds,
        },
        createdAt: message.createdAt ?? new Date(),
      };
      const committed = await this.commitCoordination({
        loungeId: message.loungeId,
        expectedRevision: loaded.coordination.revision,
        state,
        events: [event],
      });
      if (committed.committed) return committed.events[0].seq;
      if (committed.reason === 'missing') throw new Error('Lounge no longer exists');
      if (committed.reason === 'outbox_full') throw new Error('Lounge event outbox is full');
      if (committed.reason === 'state_too_large') throw new Error('Lounge state reached its safe storage limit');
    }
    throw new Error('Lounge changed concurrently while publishing chat delivery');
  },
  async listChatMessagesNeedingDelivery(loungeId, limit = 50) {
    return ChatMessage.find({ loungeId, deliveryEventSeq: { $exists: false } })
      .sort({ createdAt: 1, messageId: 1 }).limit(limit).lean();
  },
  async markChatMessageDelivered(loungeId, messageId, deliveryEventSeq) {
    const updated = await ChatMessage.updateOne(
      { loungeId, messageId, $or: [{ deliveryEventSeq: { $exists: false } }, { deliveryEventSeq }] },
      { $set: { deliveryEventSeq } },
      { runValidators: true },
    );
    if (!updated.matchedCount) throw new Error('Chat message disappeared before delivery recovery completed');
  },
  listChatSentimentMessagesSince(loungeId, since) {
    return ChatMessage.find({ loungeId, createdAt: { $gte: since } })
      .sort({ createdAt: 1, deliveryEventSeq: 1, messageId: 1 })
      .select('messageId sentimentBucket createdAt').lean();
  },
  listRecentChatMessages(loungeId, limit = 50) {
    return ChatMessage.find({ loungeId }).sort({ deliveryEventSeq: -1, createdAt: -1, messageId: -1 }).limit(limit).lean().then((messages) => messages.reverse());
  },
};
