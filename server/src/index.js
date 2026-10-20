import { app } from './app.js';
import { assertRuntimeConfig, config } from './config/env.js';
import { connectMongo } from './config/database.js';

assertRuntimeConfig();
await connectMongo(config.mongoUri);
const server = app.listen(config.port, () => {
  app.logger?.info?.(`AstraDJ API listening on port ${config.port}`);
  console.info(`AstraDJ API listening on port ${config.port}`);
});

async function shutdown(signal) {
  console.info(`${signal} received; closing AstraDJ API`);
  server.close(async () => {
    const mongoose = await import('mongoose');
    await mongoose.default.disconnect();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
