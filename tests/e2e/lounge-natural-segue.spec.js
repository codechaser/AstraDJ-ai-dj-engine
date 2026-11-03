import { expect, test } from '@playwright/test';
import mongoose from '../../server/node_modules/mongoose/index.js';
import { DJLounge } from '../../server/src/models/DJLounge.js';
import { QueueEvent } from '../../server/src/models/QueueEvent.js';
import { signInHost } from './lounge-e2e-helpers.js';

test.beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
});

test.afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test('unverified catalog audio cannot prepare a playback segue', async ({ page }) => {
  await signInHost(page, {
    email: process.env.ASTRADJ_E2E_NATURAL_HOST_EMAIL,
    password: process.env.ASTRADJ_E2E_NATURAL_HOST_PASSWORD,
    displayName: 'AstraDJ Natural Segue Host',
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: 'Live', exact: true }).click();
  await page.getByRole('combobox', { name: 'Starting track' }).selectOption('t_2001');
  await page.getByRole('button', { name: 'Create Lounge' }).click();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();

  const addTrack = page.getByRole('combobox', { name: 'Choose a catalog track to add' });
  await addTrack.selectOption('t_cc0_ivory_atlas');
  await page.getByRole('button', { name: 'Add to queue' }).click();
  await expect(page.getByRole('main').getByText('Ivory Atlas', { exact: true })).toBeVisible();
  const { loungeId } = await page.evaluate(() => JSON.parse(sessionStorage.getItem('astradj.activeLounge')));

  const audio = page.locator('audio');
  await expect.poll(() => audio.evaluate((element) => element.readyState)).toBeGreaterThanOrEqual(1);
  await audio.evaluate((element) => {
    element.playbackRate = 4;
    element.currentTime = Math.max(0, element.duration - 14);
  });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByText('No compatible queued track is available for this segue.')).toBeVisible({ timeout: 10_000 });
  expect(await audio.evaluate((element) => new URL(element.currentSrc).pathname)).toBe('/audio/city-lights-at-night-demo.mp3');

  const [saved, transitions] = await Promise.all([
    DJLounge.findOne({ loungeId }).lean(),
    QueueEvent.find({ loungeId, type: 'track.transitioned' }).lean(),
  ]);
  expect(saved.currentTrackId).toBe('t_2001');
  expect(saved.pendingSegue).toBeUndefined();
  expect(transitions).toHaveLength(0);
});
