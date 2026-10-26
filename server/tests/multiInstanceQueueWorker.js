import mongoose from 'mongoose';
import { queueRepository } from '../src/services/queueRepository.js';
import { createQueueService } from '../src/services/queueService.js';

const [loungeId, trackId, actorId] = process.argv.slice(2);
await mongoose.connect(process.env.MONGODB_TEST_URI, { serverSelectionTimeoutMS: 5000 });
try {
  if (trackId === '__drain__') await queueRepository.listQueueEvents(loungeId);
  else {
    const lounge = await queueRepository.findLoungeById(loungeId);
    const queueService = createQueueService(queueRepository);
    await queueService.addTrack({ lounge, actor: { id: actorId, role: 'Host' }, trackId });
  }
} finally {
  await mongoose.disconnect();
}
