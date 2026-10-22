import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('Home, artist and Playlist use catalog results and select real tracks in the player', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Artists in catalog' })).toBeVisible();
  const artistLink = page.getByRole('link', { name: /Kian Moretz/ });
  await expect(artistLink).toBeVisible();
  await artistLink.click();
  await expect(page.getByRole('heading', { name: 'Kian Moretz', exact: true })).toBeVisible();
  await expect(page.getByText('Thoughtness', { exact: true })).toBeVisible();
  await expect(page.getByText('1 track in the AstraDJ catalog')).toBeVisible();
  await expect(page.getByText('Album metadata is not available for this artist.')).toBeVisible();

  await page.getByRole('button', { name: 'Select Thoughtness' }).click();
  await expect(page.locator('.player-song b')).toHaveText('Thoughtness');
  await expect(page.locator('.player-song small').first()).toHaveText('Kian Moretz');

  await page.getByRole('link', { name: 'Your Library' }).click();
  await expect(page.getByRole('heading', { name: 'All Tracks' })).toBeVisible();
  await expect(page.getByText('7 tracks · 0h 18m')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select first catalog track' })).toBeEnabled();
  await page.getByRole('button', { name: 'Select first catalog track' }).click();
  await expect(page.locator('.player-song b')).toHaveText('Afterglow Avenue');

  await page.goto('/album?title=No%20album%20metadata');
  await expect(page.getByRole('heading', { name: /No album metadata/ })).toBeVisible();
  await expect(page.getByText(/does not include album names/)).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('CC0 catalog audio is served and decodes with browser playback progress', async ({ page }) => {
  await page.goto('/playlist');
  const selectTrack = page.getByRole('button', { name: 'Select Chill Beat' });
  await expect(selectTrack).toBeVisible();
  const assetResponse = page.waitForResponse((response) => response.url().endsWith('/audio/chill-beat.ogg'));
  await selectTrack.click();
  const response = await assetResponse;
  expect([200, 206]).toContain(response.status());
  expect(response.headers()['content-type']).toContain('audio/ogg');

  const audio = page.locator('audio');
  await expect.poll(() => audio.evaluate((element) => element.readyState)).toBeGreaterThanOrEqual(1);
  const metadata = await audio.evaluate((element) => ({
    src: element.currentSrc,
    duration: element.duration,
    error: element.error?.message ?? null,
  }));
  expect(metadata.src).toContain('/audio/chill-beat.ogg');
  expect(metadata.duration).toBeGreaterThan(96);
  expect(metadata.duration).toBeLessThan(97);
  expect(metadata.error).toBeNull();

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => audio.evaluate((element) => element.currentTime), { timeout: 8000 }).toBeGreaterThan(0.3);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => audio.evaluate((element) => element.paused)).toBe(true);
});

test('source-backed compatible pair serves and plays both catalog assets', async ({ page }) => {
  await page.goto('/playlist');
  for (const [title, expectedDuration] of [['Ivory Atlas', 180], ['Faded Fortress', 120]]) {
    const select = page.getByRole('button', { name: `Select ${title}` });
    await expect(select).toBeVisible();
    const assetResponse = page.waitForResponse((response) => response.url().includes(title === 'Ivory Atlas' ? '/audio/ivory-atlas.mp3' : '/audio/faded-fortress.mp3'));
    await select.click();
    const response = await assetResponse;
    expect([200, 206]).toContain(response.status());
    expect(response.headers()['content-type']).toContain('audio/mpeg');
    const audio = page.locator('audio');
    await expect.poll(() => audio.evaluate((element) => element.readyState)).toBeGreaterThanOrEqual(1);
    await expect.poll(() => audio.evaluate((element, expected) => Math.abs(element.duration - expected), expectedDuration)).toBeLessThan(0.1);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => audio.evaluate((element) => element.currentTime), { timeout: 10000 }).toBeGreaterThan(0.3);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(() => audio.evaluate((element) => element.paused)).toBe(true);
  }
});

test('catalog pages show explicit loading, empty and API error states', async ({ page }) => {
  let releaseEmptyResponse;
  const emptyResponseGate = new Promise((resolve) => { releaseEmptyResponse = resolve; });
  await page.route('**/api/v1/tracks**', async (route) => {
    if (route.request().method() === 'GET') {
      await emptyResponseGate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], page: { limit: 50, skip: 0, total: 0 } }) });
    }
    else await route.continue();
  });
  await page.goto('/playlist');
  await expect(page.getByText('Loading the AstraDJ catalog…')).toBeVisible();
  releaseEmptyResponse();
  await expect(page.getByText('No tracks are available in the catalog yet.')).toBeVisible();

  await page.unrouteAll();
  await page.route('**/api/v1/tracks**', async (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Catalog temporarily unavailable' } }) }));
  await page.goto('/artist?name=Unknown');
  await expect(page.getByRole('alert')).toContainText('Catalog temporarily unavailable');
});

test('Profile renders a persisted acoustic taste profile after reload', async ({ page }) => {
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill('Taste Profile E2E');
  await page.getByLabel('Email').fill(`taste-profile-${randomUUID()}@example.invalid`);
  await page.getByLabel('Password').fill(`TasteE2E!${randomUUID()}9`);
  const registrationResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/register'));
  await page.getByRole('button', { name: 'Create Account' }).click();
  const registration = await registrationResponse;
  expect(registration.status()).toBe(201);
  const { accessToken } = await registration.json();

  // These are explicit self-reported interaction records, not browser playback claims.
  const firstSignal = await page.request.post('/api/v1/interactions', {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { trackId: 't_2001', playedSeconds: 224, completed: true, liked: true },
  });
  const secondSignal = await page.request.post('/api/v1/interactions', {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { trackId: 't_2002', playedSeconds: 104, completed: false, liked: false },
  });
  expect(firstSignal.status()).toBe(201);
  expect(secondSignal.status()).toBe(201);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Acoustic Taste' })).toBeVisible();
  await expect(page.getByText('124–128', { exact: true })).toBeVisible();
  await expect(page.getByText(/mean 125\.3333/)).toBeVisible();
  await expect(page.getByText('8A · 9A', { exact: true })).toBeVisible();
  await expect(page.getByText(/Based on 2 eligible reports across 2 distinct tracks/)).toBeVisible();
});
