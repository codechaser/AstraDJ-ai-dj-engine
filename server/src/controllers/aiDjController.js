import { metadataRetrievalService } from '../services/metadataRetrievalService.js';
import { ApiError } from '../utils/ApiError.js';

export async function askTrackQuestion(req, res) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some((key) => key !== 'question')) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Payload must contain only question');
  }
  res.json(await metadataRetrievalService.answerQuestion({ loungeId: req.params.id, userId: req.user.id, question: req.body.question }));
}
