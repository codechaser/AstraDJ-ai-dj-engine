import mongoose from 'mongoose';
import { RateLimitCounter } from '../models/RateLimitCounter.js';

export async function connectMongo(uri) {
  mongoose.set('strictQuery', true);
  const connection = await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 30000,
    ...(process.env.ASTRA_LOUNGE_ACCEPTANCE_TRACE === 'true' ? { monitorCommands: true } : {}),
  });
  await RateLimitCounter.init();
  return connection;
}
