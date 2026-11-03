import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import cors from 'cors';
import authRoutes from './routes/authRoutes.js';
import trackRoutes from './routes/trackRoutes.js';
import healthRoutes from './routes/healthRoutes.js';
import loungeRoutes from './routes/loungeRoutes.js';
import recommendationRoutes, { interactionRouter } from './routes/recommendationRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import { ApiError } from './utils/ApiError.js';
import { config } from './config/env.js';
import { runtimeBenchmarkTiming } from './middleware/runtimeBenchmarkTiming.js';
import billingRoutes from './routes/billingRoutes.js';
import billingAdminRoutes from './routes/billingAdminRoutes.js';
import podcastRoutes from './routes/podcastRoutes.js';
import chartRoutes from './routes/chartRoutes.js';
import { handleRazorpayWebhook } from './controllers/billingController.js';
import { asyncHandler } from './utils/asyncHandler.js';

export const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: config.clientOrigin ?? false, credentials: true }));
app.use(helmet());
app.use(pinoHttp({ enabled: config.nodeEnv !== 'test', redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password'] }));
app.use(express.json({ limit: '64kb', strict: true, verify(req, _res, buffer) { if (req.originalUrl === '/api/v1/billing/webhooks/razorpay') req.rawBody = Buffer.from(buffer); } }));
app.use(cookieParser());
app.use(runtimeBenchmarkTiming);
app.use('/health', healthRoutes);
app.use('/api/v1/health', healthRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/tracks', trackRoutes);
app.use('/api/v1/podcasts', podcastRoutes);
app.use('/api/v1/charts', chartRoutes);
app.use('/api/v1/lounges', loungeRoutes);
app.use('/api/v1/interactions', interactionRouter);
app.use('/api/v1/recommendations', recommendationRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.post('/api/v1/billing/webhooks/razorpay', asyncHandler(handleRazorpayWebhook));
app.use('/api/v1/billing', billingRoutes);
app.use('/api/v1/admin/billing', billingAdminRoutes);
app.use((_req, _res, next) => next(new ApiError(404, 'ROUTE_NOT_FOUND', 'Route not found')));
app.use((err, req, res, _next) => {
  let status = err.status ?? 500;
  let code = err.code ?? 'INTERNAL_ERROR';
  let message = status >= 500 ? 'An unexpected error occurred' : err.message;
  let details = err.details;
  if (err.type === 'entity.too.large') { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body exceeds the 64kb limit'; }
  if (err instanceof SyntaxError && 'body' in err) { status = 400; code = 'INVALID_JSON'; message = 'Request body must contain valid JSON'; }
  if (err.name === 'ValidationError' || err.name === 'CastError') { status = 400; code = 'VALIDATION_ERROR'; message = 'Stored document validation failed'; details = err.errors ? Object.values(err.errors).map((e) => ({ field: e.path, message: e.message })) : undefined; }
  if (err.code === 11000) { status = 409; code = 'DUPLICATE_RESOURCE'; message = 'A resource with this identifier already exists'; }
  req.log?.[status >= 500 ? 'error' : 'warn']({ err, status, code }, 'request failed');
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
});

