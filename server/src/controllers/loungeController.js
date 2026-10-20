import { createLounge as createLoungeService } from '../services/loungeService.js';

export async function createLounge(req, res) {
  const lounge = await createLoungeService({ input: req.body, hostUserId: req.user.id });
  res.status(201).json({
    loungeId: lounge.loungeId,
    inviteCode: lounge.inviteCode,
    status: lounge.status,
    hostUserId: String(lounge.hostUserId),
    createdAt: lounge.createdAt.toISOString(),
  });
}
