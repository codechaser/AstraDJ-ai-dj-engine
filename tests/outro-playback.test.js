import test from 'node:test';
import assert from 'node:assert/strict';
import { outroPlaybackState } from '../src/api/outroPlayback.js';

const eligible = { isHost: true, connected: true, playing: true, duration: 180, windowSeconds: 12, hasCandidate: true };

test('enters the outro window on the exact configured boundary and remains eligible after entry', () => {
  assert.equal(outroPlaybackState({ ...eligible, currentTime: 167.999 }), 'before-outro');
  assert.equal(outroPlaybackState({ ...eligible, currentTime: 168 }), 'outro');
  assert.equal(outroPlaybackState({ ...eligible, currentTime: 180 }), 'outro');
});

test('pause and backward seek leave the preparation window, allowing resume to prepare again', () => {
  assert.equal(outroPlaybackState({ ...eligible, currentTime: 170, playing: false }), 'paused');
  assert.equal(outroPlaybackState({ ...eligible, currentTime: 167.5 }), 'before-outro');
  assert.equal(outroPlaybackState({ ...eligible, currentTime: 170, playing: true }), 'outro');
});

test('invalid or unavailable duration and invalid playback positions cannot schedule a segue', () => {
  for (const input of [
    { duration: 0, currentTime: 0 },
    { duration: Number.NaN, currentTime: 0 },
    { duration: Number.POSITIVE_INFINITY, currentTime: 0 },
    { duration: 180, currentTime: -0.1 },
    { duration: 180, currentTime: 180.1 },
    { duration: 180, currentTime: 170, windowSeconds: 0 },
  ]) assert.equal(outroPlaybackState({ ...eligible, currentTime: 170, ...input }), 'invalid');
});

test('a missing Host, connection, or queued candidate cannot schedule a segue', () => {
  assert.equal(outroPlaybackState({ ...eligible, isHost: false, currentTime: 170 }), 'inactive');
  assert.equal(outroPlaybackState({ ...eligible, connected: false, currentTime: 170 }), 'inactive');
  assert.equal(outroPlaybackState({ ...eligible, hasCandidate: false, currentTime: 170 }), 'inactive');
});
