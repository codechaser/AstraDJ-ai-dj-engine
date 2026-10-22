import { expect, test } from '@playwright/test';

test('Home, artist and Playlist use catalog results and select real tracks in the player', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Artists in catalog' })).toBeVisible();
  const artistLink = page.getByRole('link', { name: /Kian Moretz/ });
  await expect(artistLink).toBeVisible();
  await artistLink.click();
  await expect(page.getByRole('heading', { name: 'Kian Moretz' })).toBeVisible();
  await expect(page.getByText('Thoughtness', { exact: true })).toBeVisible();
  await expect(page.getByText('1 track in the AstraDJ catalog')).toBeVisible();
  await expect(page.getByText('Album metadata is not available for this artist.')).toBeVisible();

  await page.getByRole('button', { name: 'Select Thoughtness' }).click();
  await expect(page.locator('.player-song b')).toHaveText('Thoughtness');
  await expect(page.locator('.player-song small').first()).toHaveText('Kian Moretz');

  await page.getByRole('link', { name: 'Your Library' }).click();
  await expect(page.getByRole('heading', { name: 'All Tracks' })).toBeVisible();
  await expect(page.getByText('4 tracks · 0h 11m')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select first catalog track' })).toBeEnabled();
  await page.getByRole('button', { name: 'Select first catalog track' }).click();
  await expect(page.locator('.player-song b')).toHaveText('Afterglow Avenue');

  await page.goto('/album?title=No%20album%20metadata');
  await expect(page.getByRole('heading', { name: /No album metadata/ })).toBeVisible();
  await expect(page.getByText(/does not include album names/)).toBeVisible();
  expect(pageErrors).toEqual([]);
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
