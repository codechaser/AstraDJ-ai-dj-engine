import { validationResult } from 'express-validator';
import { ApiError } from '../utils/ApiError.js';

export function validateRequest(req, _res, next) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return next(new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', result.array().map(({ path, msg }) => ({ field: path, message: msg }))));
  }
  return next();
}
