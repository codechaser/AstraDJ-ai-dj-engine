import { listTracks as listTracksService, getAcousticProfile as getProfileService, createTrack as createTrackService } from '../services/trackService.js';

export async function listTracks(req, res) {
  res.json(await listTracksService(req.query));
}

export async function getAcousticProfile(req, res) {
  res.json(await getProfileService(req.params.trackId));
}

export async function createTrack(req, res) {
  res.status(201).json(await createTrackService(req.body));
}
