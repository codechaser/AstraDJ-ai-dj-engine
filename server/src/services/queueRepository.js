import { DJLounge } from '../models/DJLounge.js';
import { QueueEvent } from '../models/QueueEvent.js';
import { ChatMessage } from '../models/ChatMessage.js';
import { Track } from '../models/Track.js';
import { User } from '../models/User.js';

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
    return QueueEvent.find({ loungeId }).sort({ seq: 1 }).lean();
  },
  appendQueueEvents(events) {
    return QueueEvent.bulkWrite(events.map((event) => ({
      updateOne: {
        filter: { loungeId: event.loungeId, seq: event.seq },
        update: { $setOnInsert: event },
        upsert: true,
      },
    })), { ordered: true });
  },
  async getTrack(trackId) {
    return Track.findOne({ trackId }).select('trackId title artist durationSeconds audioAssetUrl acoustic').lean();
  },
  setCurrentTrack(loungeId, currentTrackId) {
    return DJLounge.findOneAndUpdate({ loungeId, status: 'live' }, { $set: { currentTrackId } }, { new: true }).lean();
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
