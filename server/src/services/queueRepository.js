import { DJLounge } from '../models/DJLounge.js';
import { QueueEvent } from '../models/QueueEvent.js';
import { ChatMessage } from '../models/ChatMessage.js';
import { Track } from '../models/Track.js';
import { User } from '../models/User.js';
import { applyCoordinationEvent, createCoordinationState, deserializeCoordinationState, serializeCoordinationState } from './coordinationState.js';

const MAX_LOUNGE_OUTBOX_EVENTS = 100;
const MAX_COORDINATION_BYTES = 8 * 1024 * 1024;

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
  async joinLounge(lounge, userId) {
    if (lounge.status === 'scheduled') {
      const started = await DJLounge.findOneAndUpdate(
        { loungeId: lounge.loungeId, status: 'scheduled' },
        { $addToSet: { participantIds: userId }, $set: { status: 'live', startedAt: new Date() } },
        { new: true },
      ).lean();
      if (started) return started;
    }
    if (lounge.participantIds.some((id) => String(id) === String(userId)) && lounge.status !== 'scheduled') return lounge;
    return DJLounge.findOneAndUpdate({ loungeId: lounge.loungeId, status: 'live' }, { $addToSet: { participantIds: userId } }, { new: true }).lean();
  },
  listQueueEvents(loungeId) {
    return this.drainOutbox(loungeId).then(() => QueueEvent.find({ loungeId }).sort({ seq: 1 }).lean());
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
  async commitCoordination({ loungeId, expectedRevision, state, events }) {
    const current = await DJLounge.findOne({ loungeId }).select('coordination').lean();
    if (!current) return { committed: false, reason: 'missing' };
    const outbox = current.coordination?.outbox ?? [];
    if (outbox.length + events.length > MAX_LOUNGE_OUTBOX_EVENTS) {
      await this.drainOutbox(loungeId);
      const refreshed = await DJLounge.findOne({ loungeId }).select('coordination').lean();
      if ((refreshed?.coordination?.outbox?.length ?? 0) + events.length > MAX_LOUNGE_OUTBOX_EVENTS) {
        return { committed: false, reason: 'outbox_full' };
      }
      return this.commitCoordination({ loungeId, expectedRevision, state, events });
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
    const updated = await DJLounge.findOneAndUpdate(
      { loungeId, status: 'live', 'coordination.revision': expectedRevision, 'coordination.outbox.100': { $exists: false } },
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
    if (!updated) return { committed: false, reason: 'conflict' };
    await this.drainOutbox(loungeId);
    return { committed: true, events: committedEvents, revision };
  },
  async drainOutbox(loungeId) {
    const lounge = await DJLounge.findOne({ loungeId }).select('coordination.outbox').lean();
    for (const event of lounge?.coordination?.outbox ?? []) {
      const { eventId, ...durableEvent } = event;
      await QueueEvent.updateOne(
        { loungeId, seq: event.seq },
        { $setOnInsert: durableEvent },
        { upsert: true },
      );
      const existing = await QueueEvent.findOne({ loungeId, seq: event.seq }).lean();
      if (!sameEvent(existing, durableEvent)) throw new Error(`Queue outbox event conflict at ${loungeId}:${event.seq}`);
      await DJLounge.updateOne({ loungeId }, { $pull: { 'coordination.outbox': { eventId } } });
    }
  },
  async getTrack(trackId) {
    return Track.findOne({ trackId }).select('trackId title artist durationSeconds audioAssetUrl acoustic').lean();
  },
  async setPendingSegue(loungeId, fromTrackId, pendingSegue) {
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
      const committed = await this.commitCoordination({ loungeId, expectedRevision: state.revision, state: next, events: [event] });
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
  listRecentChatMessages(loungeId, limit = 50) {
    return ChatMessage.find({ loungeId }).sort({ createdAt: -1, messageId: -1 }).limit(limit).lean().then((messages) => messages.reverse());
  },
};
