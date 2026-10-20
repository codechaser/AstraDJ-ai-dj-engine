import { body, param, query } from 'express-validator';
import { CAMELOT_KEYS } from '../models/Track.js';
import { isSafeAudioAssetUrl } from '../utils/audioAsset.js';

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
export const segueValidation = [
  param('id').matches(/^lg_[A-Za-z0-9_-]{8,64}$/).withMessage('Invalid Lounge ID'),
  body('currentTrackId').isString().matches(/^t_[A-Za-z0-9_-]{1,64}$/).withMessage('currentTrackId is invalid'),
  body('currentTs').isFloat({ min: 0 }).toFloat().withMessage('currentTs must be a non-negative number'),
  body('candidateTrackIds').isArray({ max: 50 }).withMessage('candidateTrackIds must be an array of at most 50 IDs'),
  body('candidateTrackIds.*').isString().matches(/^t_[A-Za-z0-9_-]{1,64}$/).withMessage('candidateTrackIds contains an invalid track ID'),
  body('candidateTrackIds').custom((ids) => Array.isArray(ids) && new Set(ids).size === ids.length).withMessage('candidateTrackIds must not contain duplicates'),
  body('currentSentimentScore').isFloat({ min: 0, max: 1 }).toFloat().withMessage('currentSentimentScore must be between 0 and 1'),
  body('recentTrackIds').optional().isArray({ max: 50 }).withMessage('recentTrackIds must be an array of at most 50 IDs'),
  body('recentTrackIds.*').optional().isString().matches(/^t_[A-Za-z0-9_-]{1,64}$/).withMessage('recentTrackIds contains an invalid track ID'),
];
export const aiQuestionValidation = [
  param('id').matches(/^lg_[A-Za-z0-9_-]{8,64}$/).withMessage('Invalid Lounge ID'),
  body('question').isString().trim().isLength({ min: 3, max: 500 }).matches(/^[^<>\u0000-\u001f]+$/).withMessage('question must be 3 to 500 plain-text characters'),
];
export const catalogValidation = [
  query('q').optional().isString().trim().isLength({ min: 1, max: 80 }).withMessage('q must be 1 to 80 characters'),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt().withMessage('limit must be an integer from 1 to 100'),
  query('skip').optional().isInt({ min: 0, max: 10000 }).toInt().withMessage('skip must be a non-negative integer no greater than 10000'),
];
export const interactionValidation = [
  body('trackId').isString().matches(/^t_[A-Za-z0-9_-]{1,64}$/).withMessage('trackId is invalid'),
  body('playedSeconds').isFloat({ min: 0 }).toFloat().withMessage('playedSeconds must be non-negative'),
  body('completed').isBoolean().toBoolean().withMessage('completed must be a boolean'),
  body('liked').isBoolean().toBoolean().withMessage('liked must be a boolean'),
  body('loungeId').optional({ nullable: true }).isString().matches(/^lg_[A-Za-z0-9_-]{8,64}$/).withMessage('loungeId is invalid'),
];
export const recommendationValidation = [
  query('limit').optional().isInt({ min: 1, max: 20 }).toInt().withMessage('limit must be an integer from 1 to 20'),
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
  body('audioAssetUrl').optional({ nullable: true }).custom(isSafeAudioAssetUrl).withMessage('audioAssetUrl must be a local /audio asset or HTTPS URL from an allow-listed host'),
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

