import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

async function registerThroughUi(page, displayName) {
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill(displayName);
  await page.getByLabel('Email').fill(`astradj-e2e-${randomUUID()}@example.invalid`);
  await page.getByLabel('Password').fill(`AstraE2E!${randomUUID()}9`);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(page.getByRole('heading', { name: displayName })).toBeVisible();
}

async function selectDemoTrack(page) {
  await page.getByRole('link', { name: 'Search' }).click();
  const selectButton = page.getByRole('button', { name: 'Select Thoughtness' });
  await expect(selectButton).toBeVisible();
  const assetResponse = page.waitForResponse((response) => response.url().endsWith('/audio/thoughtness.ogg'));
  await selectButton.click();
  const response = await assetResponse;
  expect(response.status()).toBeGreaterThanOrEqual(200);
  expect(response.status()).toBeLessThan(300);
  expect(response.headers()['content-type']).toContain('audio/ogg');
  const audio = page.locator('audio');
  await expect.poll(() => audio.evaluate((element) => element.readyState)).toBeGreaterThanOrEqual(1);
  const metadata = await audio.evaluate((element) => ({
    src: element.currentSrc,
    duration: element.duration,
    readyState: element.readyState,
    error: element.error?.message ?? null,
  }));
  expect(metadata.src).toContain('/audio/thoughtness.ogg');
  expect(metadata.duration).toBeGreaterThan(45.5);
  expect(metadata.duration).toBeLessThan(46.7);
  expect(metadata.readyState).toBeGreaterThanOrEqual(1);
  expect(metadata.error).toBeNull();
  return audio;
}

test('real audio playback creates only authenticated, owner-scoped completion history', async ({ browser }) => {
  const consoleErrors = [];
  const firstContext = await browser.newContext();
  const firstPage = await firstContext.newPage();
  firstPage.on('pageerror', (error) => consoleErrors.push(error.message));
  firstPage.on('console', (message) => {
    if (message.type() === 'error' && /127\.0\.0\.1|thoughtness\.ogg|\/api\/v1/.test(message.text())) consoleErrors.push(message.text());
  });

  await registerThroughUi(firstPage, 'Audio E2E Owner');
  const audio = await selectDemoTrack(firstPage);
  await audio.evaluate((element) => {
    element.__naturalEndedCount = 0;
    element.addEventListener('ended', () => { element.__naturalEndedCount += 1; });
  });

  const interactionResponse = firstPage.waitForResponse((response) =>
    response.url().endsWith('/api/v1/interactions') && response.request().method() === 'POST',
  { timeout: 75_000 });
  await firstPage.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => audio.evaluate((element) => element.paused)).toBe(false);
  await expect.poll(() => audio.evaluate((element) => element.currentTime), { timeout: 8000 }).toBeGreaterThan(0.3);

  await firstPage.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => audio.evaluate((element) => element.paused)).toBe(true);
  const pausedAt = await audio.evaluate((element) => element.currentTime);
  await firstPage.waitForTimeout(700);
  const afterPause = await audio.evaluate((element) => element.currentTime);
  expect(Math.abs(afterPause - pausedAt)).toBeLessThan(0.08);

  await firstPage.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => audio.evaluate((element) => element.currentTime), { timeout: 8000 }).toBeGreaterThan(afterPause + 0.25);

  await expect.poll(() => audio.evaluate((element) => element.ended), { timeout: 65_000 }).toBe(true);
  expect(await audio.evaluate((element) => element.__naturalEndedCount)).toBe(1);
  const interaction = await interactionResponse;
  expect(interaction.status()).toBe(201);
  expect(interaction.request().postDataJSON()).toMatchObject({
    trackId: 't_cc0_thoughtness', playedSeconds: 46, completed: true, liked: false,
  });
  expect(await interaction.json()).toMatchObject({ trackId: 't_cc0_thoughtness', source: 'self_reported' });

  const ownerHistoryResponse = firstPage.waitForResponse((response) => response.url().includes('/api/v1/dashboard/playback-history'));
  await firstPage.goto('/profile');
  const ownerHistory = await (await ownerHistoryResponse).json();
  expect(ownerHistory.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ trackId: 't_cc0_thoughtness', completed: true, playedSeconds: 46, source: 'self_reported' }),
  ]));
  await expect(firstPage.getByText('t_cc0_thoughtness', { exact: true })).toBeVisible();

  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  secondPage.on('pageerror', (error) => consoleErrors.push(error.message));
  await registerThroughUi(secondPage, 'Audio E2E Other Listener');
  const otherHistoryResponse = secondPage.waitForResponse((response) => response.url().includes('/api/v1/dashboard/playback-history'));
  await secondPage.goto('/profile');
  const otherHistory = await (await otherHistoryResponse).json();
  expect(otherHistory.items).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ trackId: 't_cc0_thoughtness' }),
  ]));
  await expect(secondPage.getByText('No listening reports yet.')).toBeVisible();

  const incompleteAudio = await selectDemoTrack(secondPage);
  const incompleteInteractions = [];
  secondPage.on('request', (request) => {
    if (request.url().endsWith('/api/v1/interactions') && request.method() === 'POST') incompleteInteractions.push(request);
  });
  await secondPage.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => incompleteAudio.evaluate((element) => element.currentTime), { timeout: 8000 }).toBeGreaterThan(0.3);
  await secondPage.getByRole('button', { name: 'Pause', exact: true }).click();
  await secondPage.waitForTimeout(1200);
  expect(incompleteInteractions).toHaveLength(0);
  await secondPage.goto('/profile');
  await expect(secondPage.getByText('No listening reports yet.')).toBeVisible();

  expect(consoleErrors).toEqual([]);
  await secondContext.close();
  await firstContext.close();
});
