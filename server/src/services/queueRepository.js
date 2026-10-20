import { DJLounge } from '../models/DJLounge.js';
import { QueueEvent } from '../models/QueueEvent.js';
import { Track } from '../models/Track.js';
import { User } from '../models/User.js';

export const queueRepository = {
  findLoungeByInvite(inviteCode) {
    return DJLounge.findOne({ inviteCode: inviteCode.toUpperCase(), status: { $ne: 'ended' } }).lean();
  },
  findLoungeById(loungeId) {
    return DJLounge.findOne({ loungeId, status: { $ne: 'ended' } }).lean();
  },
  async joinLounge(lounge, userId) {
    if (lounge.participantIds.some((id) => String(id) === String(userId))) return lounge;
    return DJLounge.findOneAndUpdate({ loungeId: lounge.loungeId, status: { $ne: 'ended' } }, { $addToSet: { participantIds: userId } }, { new: true }).lean();
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
    return Track.findOne({ trackId }).select('trackId title artist durationSeconds acoustic').lean();
  },
  getUser(userId) {
    return User.findById(userId).select('email displayName role').lean();
  },
};
