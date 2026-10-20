import { body, param, query } from 'express-validator';
import { CAMELOT_KEYS } from '../models/Track.js';

export const registerValidation = [
  body('email').isEmail().withMessage('Must be a valid email').normalizeEmail(),
  body('displayName').isString().trim().isLength({ min: 1, max: 60 }).withMessage('Display name must be 1 to 60 characters').matches(/^[^<>\u0000-\u001f]+$/).withMessage('Display name contains unsupported characters'),
  body('password').isString().isLength({ min: 10, max: 128 }).withMessage('Password must be 10 to 128 characters'),
];
export const loginValidation = [
  body('email').isEmail().withMessage('Must be a valid email').normalizeEmail(),
  body('password').isString().isLength({ min: 1, max: 128 }).withMessage('Password is required'),
];
export const trackIdValidation = [param('trackId').matches(/^t_[A-Za-z0-9_-]{1,64}$/).withMessage('Invalid trackId')];
export const catalogValidation = [
  query('q').optional().isString().trim().isLength({ min: 1, max: 80 }).withMessage('q must be 1 to 80 characters'),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt().withMessage('limit must be an integer from 1 to 100'),
  query('skip').optional().isInt({ min: 0, max: 10000 }).toInt().withMessage('skip must be a non-negative integer no greater than 10000'),
];
export const createLoungeValidation = [
  body('seedTrackId').isString().matches(/^t_[A-Za-z0-9_-]{1,64}$/).withMessage('seedTrackId is invalid'),
  body('vibeProfile').isString().trim().isLength({ min: 1, max: 100 }).matches(/^[^<>\u0000-\u001f]+$/).withMessage('vibeProfile must be 1 to 100 plain-text characters'),
  body('maxParticipants').isInt({ min: 2, max: 50 }).toInt().withMessage('maxParticipants must be between 2 and 50'),
  body('bpmTolerancePct').isFloat({ min: 0, max: 8 }).toFloat().withMessage('bpmTolerancePct must be between 0 and 8'),
  body('soundclashEnabled').isBoolean().toBoolean().withMessage('soundclashEnabled must be a boolean'),
  body('aiVerbosity').isIn(['low', 'normal', 'high']).withMessage('aiVerbosity must be low, normal, or high'),
];
export const createTrackValidation = [
  body('trackId').isString().matches(/^t_[A-Za-z0-9_-]{1,64}$/).withMessage('trackId must use t_ followed by 1 to 64 safe characters'),
  body('title').isString().trim().isLength({ min: 1, max: 120 }).matches(/^[^<>\u0000-\u001f]+$/).withMessage('title must be 1 to 120 plain-text characters'),
  body('artist').isString().trim().isLength({ min: 1, max: 120 }).matches(/^[^<>\u0000-\u001f]+$/).withMessage('artist must be 1 to 120 plain-text characters'),
  body('durationSeconds').isInt({ min: 1 }).toInt().withMessage('durationSeconds must be a positive integer'),
  body('audioAssetUrl').optional({ nullable: true }).isURL({ protocols: ['http', 'https'], require_protocol: true }).withMessage('audioAssetUrl must be an HTTP(S) URL'),
  body('acoustic').isObject().withMessage('acoustic profile is required'),
  body('acoustic.bpm').isFloat({ min: 1, max: 300 }).toFloat().withMessage('bpm must be greater than 0 and no more than 300'),
  body('acoustic.camelotKey').isIn(CAMELOT_KEYS).withMessage('camelotKey must be one of the 24 Camelot keys'),
  body('acoustic.energy').isFloat({ min: 0, max: 1 }).toFloat().withMessage('energy must be between 0 and 1'),
  body('acoustic.valence').isFloat({ min: 0, max: 1 }).toFloat().withMessage('valence must be between 0 and 1'),
  body('timeline').optional().isArray({ max: 100 }).withMessage('timeline must be an array of at most 100 entries'),
  body('timeline.*.ts').optional().isFloat({ min: 0 }).toFloat().withMessage('timeline ts must be non-negative'),
  body('timeline.*.type').optional().isIn(['sample_credit', 'trivia', 'glossary']).withMessage('timeline type is invalid'),
  body('timeline.*.text').optional().isString().trim().isLength({ min: 1, max: 500 }).matches(/^[^<>\u0000-\u001f]+$/).withMessage('timeline text must be 1 to 500 plain-text characters'),
];

