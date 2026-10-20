import crypto from 'node:crypto';
import { DJLounge } from '../models/DJLounge.js';
import { Track } from '../models/Track.js';
import { ApiError } from '../utils/ApiError.js';

const inviteAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomInviteCode() {
  const bytes = crypto.randomBytes(4);
  return `SP-${Array.from(bytes, (byte) => inviteAlphabet[byte % inviteAlphabet.length]).join('')}`;
}

export async function createLounge({ input, hostUserId }) {
  const { seedTrackId, vibeProfile, maxParticipants, bpmTolerancePct, soundclashEnabled, aiVerbosity } = input;
  const seedTrack = await Track.findOne({ trackId: seedTrackId }).select('trackId');
  if (!seedTrack) throw new ApiError(404, 'SEED_TRACK_NOT_FOUND', 'The starting track does not exist');
  const now = new Date();
  return DJLounge.create({
    loungeId: `lg_${crypto.randomBytes(6).toString('hex')}`,
    inviteCode: randomInviteCode(),
    hostUserId,
    vibeProfile,
    queue: [seedTrack.trackId],
    currentTrackId: seedTrack.trackId,
    status: 'scheduled',
    participantIds: [hostUserId],
    createdAt: now,
    settings: { maxParticipants, bpmTolerancePct, soundclashEnabled, aiVerbosity },
  });
}
