import { createServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { config, assertRuntimeConfig } from '../src/config/env.js';
import { connectMongo } from '../src/config/database.js';
import { attachLoungeGateway } from '../src/socket/loungeGateway.js';

assertRuntimeConfig();
await connectMongo(config.mongoUri);
const server = createServer();
const io = new SocketServer(server, { cors: { origin: false }, transports: ['websocket'] });
const gateway = attachLoungeGateway(io, {
  participantLeaseTtlMs: Number(process.env.TEST_PARTICIPANT_LEASE_TTL_MS) || undefined,
  gatewayPresenceTtlMs: Number(process.env.TEST_GATEWAY_PRESENCE_TTL_MS) || undefined,
  presencePollIntervalMs: Number(process.env.TEST_GATEWAY_PRESENCE_POLL_MS) || undefined,
  pollIntervalMs: 20,
});
server.listen(Number(process.env.PORT), '127.0.0.1', () => process.stdout.write('READY\n'));

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await gateway.close();
  await new Promise((resolve) => io.close(resolve));
  const mongoose = (await import('mongoose')).default;
  await mongoose.disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });
