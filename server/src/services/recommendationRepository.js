import { DJLounge } from '../models/DJLounge.js';
import { Interaction } from '../models/Interaction.js';
import { Track } from '../models/Track.js';

export const recommendationRepository = {
  getTrack(trackId) {
    return Track.findOne({ trackId }).select('trackId title artist durationSeconds acoustic').lean();
  },
  listTracks() {
    return Track.find({}).sort({ trackId: 1 }).select('trackId title artist durationSeconds acoustic').lean();
  },
  createInteraction(data) {
    return Interaction.create(data);
  },
  listInteractionsForUser(userId) {
    return Interaction.find({ userId }).sort({ createdAt: 1, _id: 1 }).lean();
  },
  listInteractionsForUsers(userIds) {
    return userIds.length ? Interaction.find({ userId: { $in: userIds } }).lean() : [];
  },
  async getRecentCoListenerIds({ loungeId, trackId, userId, since }) {
    const ids = await Interaction.distinct('userId', { loungeId, trackId, userId: { $ne: userId }, createdAt: { $gte: since } });
    return ids.map(String);
  },
  async linkCoListeners({ interactionId, loungeId, trackId, userId, coListenerIds, since }) {
    if (!coListenerIds.length) return;
    await Interaction.updateOne({ _id: interactionId }, { $addToSet: { coListenedWith: { $each: coListenerIds } } });
    await Interaction.updateMany(
      { loungeId, trackId, userId: { $in: coListenerIds }, createdAt: { $gte: since } },
      { $addToSet: { coListenedWith: userId } },
    );
  },
  findLounge(loungeId) {
    return DJLounge.findOne({ loungeId, status: { $ne: 'ended' } }).lean();
  },
};
