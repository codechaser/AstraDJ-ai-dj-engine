import { segueService } from '../services/segueService.js';

export async function requestSegue(req, res) {
  res.json(await segueService.requestSegue({ loungeId: req.params.id, userId: req.user.id, input: req.body, includeCommentary: req.user.aiDjCommentary }));
}
