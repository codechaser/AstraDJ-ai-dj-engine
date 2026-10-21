import crypto from 'node:crypto';
import { DJLounge } from '../models/DJLounge.js';
import { LoungeMetricEvent } from '../models/LoungeMetricEvent.js';
import { ApiError } from '../utils/ApiError.js';

const duplicateKey = (error) => error?.code === 11000;

export function createLoungeMetricEventService({ loungeModel = DJLounge, eventModel = LoungeMetricEvent, now = () => new Date() } = {}) {
  async function append({ loungeId, type, userId, requestId = null, participantCount = null }) {
    if (type === 'ai.question.asked' && requestId) {
      const previous = await eventModel.findOne({ loungeId, userId, requestId }).lean();
      if (previous) return previous;
    }

    const lounge = await loungeModel.findOneAndUpdate(
      { loungeId, status: 'live' },
      { $inc: { sessionEventSeq: 1 } },
      { new: true },
    ).select('sessionEventSeq').lean();
    if (!lounge) throw new ApiError(409, 'LOUNGE_ENDED', 'The Lounge session is no longer active');

    const event = {
      eventId: crypto.randomUUID(), loungeId, seq: lounge.sessionEventSeq,
      type, userId, requestId, participantCount, createdAt: now(),
    };
    try {
      return await eventModel.create(event);
    } catch (error) {
      if (duplicateKey(error) && type === 'ai.question.asked' && requestId) {
        const previous = await eventModel.findOne({ loungeId, userId, requestId }).lean();
        if (previous) return previous;
      }
      await loungeModel.updateOne({ loungeId }, { $set: { analyticsTrackingVersion: 0 } });
      throw error;
    }
  }

  return {
    recordPresence({ loungeId, userId, action, participantCount }) {
      if (!['joined', 'left'].includes(action) || !Number.isInteger(participantCount) || participantCount < 0) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Presence event is invalid');
      }
      return append({ loungeId, userId, type: action === 'joined' ? 'participant.joined' : 'participant.left', participantCount });
    },
    recordAiQuestion({ loungeId, userId, requestId }) {
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'A valid Idempotency-Key is required');
      }
      return append({ loungeId, userId, type: 'ai.question.asked', requestId });
    },
  };
}

export const loungeMetricEventService = createLoungeMetricEventService();
