import { metadataRetrievalService } from '../services/metadataRetrievalService.js';
import { loungeMetricEventService } from '../services/loungeMetricEventService.js';
import { loungeCommandCoordinator } from '../services/loungeCommandCoordinator.js';
import { ApiError } from '../utils/ApiError.js';

export async function askTrackQuestion(req, res) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some((key) => key !== 'question')) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Payload must contain only question');
  }
  const requestId = req.get('Idempotency-Key');
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A valid Idempotency-Key header is required');
  }
  const result = await loungeCommandCoordinator.run(req.params.id, async () => {
    const answer = await metadataRetrievalService.answerQuestion({ loungeId: req.params.id, userId: req.user.id, question: req.body.question });
    await loungeMetricEventService.recordAiQuestion({ loungeId: req.params.id, userId: req.user.id, requestId });
    return answer;
  });
  res.json(result);
}
