import { createServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { app } from './app.js';
import { assertRuntimeConfig, config } from './config/env.js';
import { connectMongo } from './config/database.js';
import { attachLoungeGateway } from './socket/loungeGateway.js';
import { segueService } from './services/segueService.js';

assertRuntimeConfig();
await connectMongo(config.mongoUri);
const server = createServer(app);
const io = new SocketServer(server, { cors: { origin: config.clientOrigin ?? false, credentials: true }, maxHttpBufferSize: 64 * 1024, transports: ['websocket', 'polling'] });
const { queueService, chatService, soundclashService, publishAnnouncement, close: closeLoungeGateway } = attachLoungeGateway(io);
segueService.setAnnouncementPublisher(publishAnnouncement);
server.listen(config.port, () => {
  app.logger?.info?.(`AstraDJ API listening on port ${config.port}`);
  console.info(`AstraDJ API listening on port ${config.port}`);
});

async function shutdown(signal) {
  console.info(`${signal} received; closing AstraDJ API`);
  await closeLoungeGateway();
  soundclashService.close();
  try { await queueService.flushAll(); }
  catch (error) { console.error('Could not flush pending queue events during shutdown:', error.message); }
  try { await chatService.flushAll(); }
  catch (error) { console.error('Could not flush pending chat messages during shutdown:', error.message); }
  io.close(async () => {
    const mongoose = await import('mongoose');
    await mongoose.default.disconnect();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
