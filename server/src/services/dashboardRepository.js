import { ChatMessage } from '../models/ChatMessage.js';
import { DJLounge } from '../models/DJLounge.js';
import { Interaction } from '../models/Interaction.js';
import { LoungeMetricEvent } from '../models/LoungeMetricEvent.js';
import { queueRepository } from './queueRepository.js';

export const dashboardRepository = {
  listInteractionsForUser(userId, limit) {
    return Interaction.find({ userId }).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
  },
  findLounge(loungeId) { return DJLounge.findOne({ loungeId }).lean(); },
  listQueueEvents(loungeId) { return queueRepository.listQueueEvents(loungeId); },
  listSentimentMessages(loungeId) {
    return ChatMessage.find({ loungeId }).sort({ createdAt: 1, messageId: 1 })
      .select('createdAt sentimentScore sentimentBucket').lean();
  },
  listLoungeMetricEvents(loungeId) {
    return LoungeMetricEvent.find({ loungeId }).sort({ seq: 1 })
      .select('seq type userId requestId participantCount createdAt').lean();
  },
};
