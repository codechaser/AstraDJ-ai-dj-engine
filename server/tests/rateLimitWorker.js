import readline from 'node:readline';
import mongoose from 'mongoose';
import { connectMongo } from '../src/config/database.js';
import { createDistributedRateLimiter } from '../src/services/distributedRateLimiter.js';

await connectMongo(process.env.MONGODB_URI);
process.stdout.write('READY\n');

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.type === 'close') break;
  try {
    const limiter = createDistributedRateLimiter({ now: () => request.now });
    const result = await limiter.consume(request);
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: request.id, error: { code: error.code, status: error.status } })}\n`);
  }
}
await mongoose.disconnect();
