import mongoose from 'mongoose';
import { assertRuntimeConfig, config } from '../config/env.js';
import { connectMongo } from '../config/database.js';
import { Track } from '../models/Track.js';
import { seedTracks } from './tracks.js';

try {
  assertRuntimeConfig();
  await connectMongo(config.mongoUri);
  for (const track of seedTracks) {
    await Track.updateOne({ trackId: track.trackId }, { $set: track }, { upsert: true, runValidators: true });
  }
  console.info(`Seeded ${seedTracks.length} AstraDJ track profiles.`);
} catch (error) {
  console.error('Track seeding failed:', error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
