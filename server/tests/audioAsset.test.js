import { Track } from '../src/models/Track.js';
import { isSafeAudioAssetUrl } from '../src/utils/audioAsset.js';

const trackData = (audioAssetUrl) => ({
  trackId: 't_audio_test', title: 'Audio Test', artist: 'AstraDJ', durationSeconds: 46,
  audioAssetUrl, acoustic: { bpm: 120, camelotKey: '8A', energy: 0.5, valence: 0.5 }, timeline: [],
});

test('tracks accept absent and in-app audio assets, while rejecting unsafe or untrusted sources', async () => {
  expect(isSafeAudioAssetUrl(null)).toBe(true);
  expect(isSafeAudioAssetUrl('/audio/thoughtness.ogg')).toBe(true);
  expect(isSafeAudioAssetUrl('/audio/../secret.ogg')).toBe(false);
  expect(isSafeAudioAssetUrl('file:///C:/music/song.mp3')).toBe(false);
  expect(isSafeAudioAssetUrl('javascript:alert(1)')).toBe(false);
  expect(isSafeAudioAssetUrl('http://media.example.test/song.mp3')).toBe(false);
  expect(isSafeAudioAssetUrl('https://untrusted.example.test/song.mp3')).toBe(false);
  await expect(new Track(trackData(null)).validate()).resolves.toBeUndefined();
  await expect(new Track(trackData('/audio/thoughtness.ogg')).validate()).resolves.toBeUndefined();
  await expect(new Track(trackData('file:///C:/music/song.mp3')).validate()).rejects.toThrow('audioAssetUrl');
});

test('optional remote media is accepted only from exact HTTPS host allow-list entries', () => {
  const previous = process.env.AUDIO_ASSET_ALLOWED_HOSTS;
  process.env.AUDIO_ASSET_ALLOWED_HOSTS = 'media.example.test, cdn.example.test';
  try {
    expect(isSafeAudioAssetUrl('https://media.example.test/audio/song.mp3')).toBe(true);
    expect(isSafeAudioAssetUrl('https://media.example.test:444/audio/song.mp3')).toBe(false);
    expect(isSafeAudioAssetUrl('https://user@media.example.test/audio/song.mp3')).toBe(false);
    expect(isSafeAudioAssetUrl('https://sub.media.example.test/audio/song.mp3')).toBe(false);
    expect(isSafeAudioAssetUrl('https://media.example.test/audio/song.html')).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.AUDIO_ASSET_ALLOWED_HOSTS;
    else process.env.AUDIO_ASSET_ALLOWED_HOSTS = previous;
  }
});
