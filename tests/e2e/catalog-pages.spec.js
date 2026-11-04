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
  await page.getByRole('tab', { name: 'Albums' }).click();
  await expect(page.getByText(/No album records are linked to this artist in the catalog/)).toBeVisible();
  await page.getByRole('tab', { name: 'Tracks' }).click();

  await page.getByRole('button', { name: 'Select Thoughtness' }).click();
  await expect(page.locator('.player-song b')).toHaveText('Thoughtness');
  await expect(page.locator('.player-song small').first()).toHaveText('Kian Moretz');

  await page.getByRole('link', { name: 'Your Library' }).click();
  await expect(page.getByRole('heading', { name: 'All Tracks' })).toBeVisible();
  await expect(page.getByText('7 tracks · 0h 18m')).toBeVisible();
  const catalogCover = page.locator('.catalog-hero-art');
  await expect.poll(() => catalogCover.evaluate((element) => getComputedStyle(element, '::after').content)).toBe('"♫"');
  await expect.poll(() => page.locator('.catalog-page-tracks .catalog-cover').first().evaluate((element) => getComputedStyle(element, '::after').content)).toBe('"♫"');
  await expect(page.getByRole('button', { name: 'Select first catalog track' })).toBeEnabled();
  await page.getByRole('button', { name: 'Select first catalog track' }).click();
  await expect(page.locator('.player-song b')).toHaveText('Afterglow Avenue');

  await page.goto('/album?title=No%20album%20metadata');
  await expect(page.getByRole('heading', { name: /No album metadata/ })).toBeVisible();
  await expect(page.getByText(/does not include album names/)).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('Home shows a catalog vibe snapshot from saved acoustic profiles', async ({ page }) => {
  await page.goto('/');
  const vibe = page.locator('.vibe-card');
  await expect(vibe.getByRole('heading', { name: 'Catalog vibe snapshot' })).toBeVisible();
  await expect(vibe).toContainText('Estimated from 1 catalog tracks with acoustic profiles.');
  await expect(vibe).toContainText('Energy');
  await expect(vibe).toContainText('Valence');
  await expect(vibe).toContainText('Catalog-level estimates, not your personal listening profile.');
  await expect(vibe).not.toContainText('Vibe profile unavailable');
});

test('Home shows real Apple Music India Most Played albums with source links', async ({ page }) => {
  await page.goto('/');
  const section = page.getByRole('region', { name: 'Popular albums · India' });
  await expect(section.getByRole('heading', { name: 'Popular albums · India' })).toBeVisible();
  const cards = section.locator('.popular-album-card');
  await expect(cards.first()).toBeVisible({ timeout: 20_000 });
  expect(await cards.count()).toBeGreaterThan(0);
  await expect.poll(() => cards.first().locator('img').evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(cards.first()).toHaveAttribute('href', /^https:\/\/music\.apple\.com\//);
  await expect(section).toContainText('Ranked by Apple Music India. Album links open Apple Music');
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

test('withdrawn demo tracks remain catalog entries without unavailable audio or acoustic claims', async ({ page }) => {
  await page.goto('/playlist');
  for (const title of ['Ivory Atlas', 'Faded Fortress']) {
    const select = page.getByRole('button', { name: `Select ${title}` });
    await expect(select).toBeVisible();
    await select.click();
    await expect(page.locator('.player-availability')).toHaveText('Audio unavailable');
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
    expect(await page.locator('audio').evaluate((element) => element.currentSrc)).toBe('');
  }
});

test('the three fictional catalog tracks use documented CC0 demo substitutions that really play', async ({ page }) => {
  await page.goto('/playlist');
  const fixtures = [
    ['t_2001', 'Night Drive', '/audio/city-lights-at-night-demo.mp3', 190],
    ['t_2002', 'Blue Horizon', '/audio/fresh-start-demo.mp3', 120],
    ['t_2003', 'Afterglow Avenue', '/audio/swaying-demo.mp3', 328],
  ];
  const audio = page.locator('audio');

  for (const [trackId, title, assetPath, expectedDuration] of fixtures) {
    const assetResponsePromise = page.waitForResponse((response) => response.url().endsWith(assetPath));
    await page.getByRole('button', { name: `Select ${title}` }).click();
    const assetResponse = await assetResponsePromise;
    expect([200, 206]).toContain(assetResponse.status());
    expect(assetResponse.headers()['content-type']).toContain('audio/mpeg');

    await expect.poll(() => audio.evaluate((element) => element.readyState)).toBeGreaterThanOrEqual(1);
    const metadata = await audio.evaluate((element) => ({
      source: new URL(element.currentSrc).pathname,
      duration: element.duration,
      error: element.error?.message ?? null,
    }));
    expect(metadata.source).toBe(assetPath);
    expect(Math.abs(metadata.duration - expectedDuration)).toBeLessThan(1);
    expect(metadata.error).toBeNull();

    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => audio.evaluate((element) => element.currentTime), { timeout: 10000 }).toBeGreaterThan(0.3);
    const playbackPosition = await audio.evaluate((element) => element.currentTime);
    console.info(`[catalog-audio-e2e] ${trackId} status=${assetResponse.status()} type=${assetResponse.headers()['content-type']} duration=${metadata.duration.toFixed(3)}s playbackPosition=${playbackPosition.toFixed(3)}s`);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(() => audio.evaluate((element) => element.paused)).toBe(true);
  }
});

test('a missing local audio asset is not accepted as playable audio', async ({ page }) => {
  await page.goto('/playlist');
  const missingUrl = new URL('/audio/astradj-intentionally-missing-test.mp3', page.url()).toString();
  const response = await page.request.get(missingUrl);
  // Vite's SPA fallback may return index.html with 200 for a missing public URL;
  // assert that it never claims to be an audio response and that the browser decoder rejects it.
  expect(response.headers()['content-type'] ?? '').not.toContain('audio/');
  const mediaError = await page.evaluate((src) => new Promise((resolve, reject) => {
    const audio = document.createElement('audio');
    const timeout = window.setTimeout(() => reject(new Error('Missing audio source did not produce a media error')), 5000);
    audio.addEventListener('error', () => {
      window.clearTimeout(timeout);
      resolve(audio.error?.code ?? null);
    }, { once: true });
    audio.src = src;
    audio.load();
  }), missingUrl);
  expect(mediaError).not.toBeNull();
});

test('Now Playing detail tabs show catalog metadata and same-artist tracks', async ({ page }) => {
  await page.goto('/playlist');
  await page.getByRole('button', { name: 'Select Ivory Atlas' }).click();
  await page.locator('.player-song a').click();
  await expect(page.getByRole('heading', { name: 'Ivory Atlas', exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'About' }).click();
  const details = page.getByRole('tabpanel');
  await expect(details.getByText('Kainotomic', { exact: true })).toBeVisible();
  await expect(details.getByText('3:00', { exact: true })).toBeVisible();
  await expect(details.getByText('Metadata only', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Related' }).click();
  await expect(details.getByText('Faded Fortress', { exact: true })).toBeVisible();
  await details.getByRole('button', { name: 'Play Faded Fortress' }).click();
  await expect(page.getByRole('heading', { name: 'Faded Fortress', exact: true })).toBeVisible();
  await expect(page.locator('.player-availability')).toHaveText('Audio unavailable');

  await page.getByRole('tab', { name: 'Lyrics' }).click();
  await expect(details.getByText('Lyrics are unavailable for this track.')).toBeVisible();
});

test('Home Customize opens the AI DJ mood controls and mood selection responds', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Customize', exact: true }).click();
  await expect(page).toHaveURL(/\/ai-dj#customize$/);
  const moodGroup = page.getByRole('group', { name: 'Choose a mood' });
  await expect(moodGroup).toBeVisible();
  const workout = moodGroup.getByRole('button', { name: 'Workout' });
  await workout.click();
  await expect(workout).toHaveClass(/selected/);
});

test('local artist portraits and track covers load and stay consistent in the player', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.player-song .artwork-placeholder')).toBeVisible();
  const portraits = page.locator('.artist-row .catalog-artist-art');
  await expect(portraits).toHaveCount(6);
  await expect.poll(() => portraits.evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0))).toBe(true);
  const artistSources = await portraits.evaluateAll((images) => images.map((image) => new URL(image.src).pathname));
  expect(new Set(artistSources).size).toBe(6);
  expect(artistSources.every((src) => src.startsWith('/assets/artists/'))).toBe(true);
  const allCovers = ['night-drive', 'blue-horizon', 'afterglow-avenue', 'thoughtness', 'chill-beat', 'ivory-atlas', 'faded-fortress'].map((name) => `/assets/covers/${name}.webp`);
  for (const assetPath of [...artistSources, ...allCovers]) {
    const response = await page.request.get(new URL(assetPath, page.url()).toString());
    expect(response.status(), assetPath).toBe(200);
    expect(response.headers()['content-type'], assetPath).toContain('image/webp');
  }

  const homeCovers = page.locator('.trending-item .catalog-cover');
  await expect(homeCovers.first()).toBeVisible();
  await expect.poll(() => homeCovers.evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0))).toBe(true);
  expect((await homeCovers.evaluateAll((images) => images.map((image) => new URL(image.src).pathname))).every((src) => src.startsWith('/assets/covers/'))).toBe(true);

  await page.getByRole('link', { name: 'Your Library' }).click();
  const nightDriveRow = page.locator('.catalog-page-tracks .song-row').filter({ hasText: 'Night Drive' });
  await expect(nightDriveRow.locator('.catalog-cover')).toHaveAttribute('src', '/assets/covers/night-drive.webp');
  await page.getByRole('button', { name: 'Select Night Drive' }).click();
  const playerArtwork = page.locator('.player-song img');
  await expect(playerArtwork).toBeVisible();
  await expect.poll(() => playerArtwork.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  const selectedCover = await playerArtwork.getAttribute('src');
  expect(new URL(selectedCover, page.url()).pathname).toBe('/assets/covers/night-drive.webp');

  await page.locator('.player-song a').click();
  await expect(page.getByRole('heading', { name: 'Night Drive', exact: true })).toBeVisible();
  await expect(page.locator('.now-cover')).toHaveAttribute('src', selectedCover);
  await expect.poll(() => page.locator('.now-cover').evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);

  await page.getByRole('link', { name: 'Search' }).click();
  await page.getByRole('textbox', { name: 'Search the AstraDJ track catalog' }).fill('Night Drive');
  const searchCover = page.locator('.catalog-row .catalog-cover');
  await expect(searchCover).toBeVisible();
  await expect(searchCover).toHaveAttribute('src', selectedCover);

  await page.getByRole('link', { name: 'Your Library' }).click();
  await page.getByRole('button', { name: 'Select Blue Horizon' }).click();
  await expect(page.locator('.player-song img')).toHaveAttribute('src', '/assets/covers/blue-horizon.webp');
});

test('Artist Albums and About tabs are interactive and use only catalog facts', async ({ page }) => {
  await page.goto('/artist?name=The%20Quiet%20Current');
  await expect(page.getByRole('heading', { name: 'The Quiet Current', exact: true })).toBeVisible();

  const albumsTab = page.getByRole('tab', { name: 'Albums' });
  await expect(albumsTab).toBeEnabled();
  await albumsTab.click();
  await expect(albumsTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Albums by The Quiet Current' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('No album records are linked to this artist in the catalog.');
  await expect(page.getByText('Afterglow Avenue', { exact: true })).toBeVisible();

  const aboutTab = page.getByRole('tab', { name: 'About' });
  await aboutTab.click();
  await expect(aboutTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'About The Quiet Current' })).toBeVisible();
  await expect(page.getByText('Tracks in catalog')).toBeVisible();
  await expect(page.getByText('1 of 1', { exact: true })).toBeVisible();
  await expect(page.locator('.artist-about dl').getByText('5:28', { exact: true })).toBeVisible();
  await expect(page.getByText('no biography has been supplied.')).toBeVisible();
});

test('Home shows playable catalog starters when a new account has no personalized recommendations', async ({ page }) => {
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill('Cold Start E2E');
  await page.getByLabel('Email').fill(`cold-start-${randomUUID()}@example.invalid`);
  await page.getByLabel('Password').fill(`ColdStart!${randomUUID()}9`);
  const registrationResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/register'));
  await page.getByRole('button', { name: 'Create Account' }).click();
  expect((await registrationResponse).status()).toBe(201);

  const recommendationsResponse = page.waitForResponse((response) => response.url().includes('/api/v1/recommendations?limit='));
  await page.getByRole('link', { name: 'Home' }).click();
  const response = await recommendationsResponse;
  expect(response.status()).toBe(200);
  expect((await response.json()).items).toEqual([]);

  await expect(page.getByRole('heading', { name: 'Explore the catalog' })).toBeVisible();
  await expect(page.getByText('These are starter picks, not personalized recommendations')).toBeVisible();
  const starterCards = page.locator('.mix-card');
  await expect(starterCards).toHaveCount(4);
  await expect.poll(() => starterCards.locator('img').evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0))).toBe(true);
  const firstTitle = await starterCards.first().locator('b').innerText();
  await starterCards.first().click();
  await expect(page.locator('.player-song b')).toHaveText(firstTitle);
});

test('anonymous Home lists catalog artists and offers public playable catalog picks', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Artists in catalog' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Kian Moretz/ })).toBeVisible();
  await expect(page.locator('.artist-card')).toHaveCount(6);
  await expect(page.getByRole('heading', { name: 'Explore the catalog' })).toBeVisible();
  await expect(page.locator('.mix-card').first()).toBeVisible();
  await expect(page.getByText('These are starter picks, not personalized recommendations')).toBeVisible();
  await expect(page.getByText('Sign in to request private recommendations.')).toHaveCount(0);
});

test('empty listening and Lounge history guide the signed-in user to real activity flows', async ({ page }) => {
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill('Profile Empty States E2E');
  await page.getByLabel('Email').fill(`profile-empty-${randomUUID()}@example.invalid`);
  await page.getByLabel('Password').fill(`ProfileEmpty!${randomUUID()}9`);
  const registrationResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/register'));
  await page.getByRole('button', { name: 'Create Account' }).click();
  expect((await registrationResponse).status()).toBe(201);

  await expect(page.getByText('Finish listening to a real catalog track to add a report here.')).toBeVisible();
  await expect(page.getByText(/Start or join a Lounge to create a real session/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Browse tracks' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create or join a Lounge' })).toBeVisible();

  await page.getByRole('link', { name: 'Browse tracks' }).click();
  await expect(page.getByRole('heading', { name: 'All Tracks' })).toBeVisible();
  await page.goto('/profile');
  await page.getByRole('link', { name: 'Create or join a Lounge' }).click();
  await expect(page).toHaveURL(/\/queue$/);
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
    data: { trackId: 't_2001', playedSeconds: 190, completed: true, liked: true },
  });
  const secondSignal = await page.request.post('/api/v1/interactions', {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { trackId: 't_cc0_ivory_atlas', playedSeconds: 180, completed: true, liked: true },
  });
  expect(firstSignal.status()).toBe(201);
  expect(secondSignal.status()).toBe(201);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Acoustic Taste' })).toBeVisible();
  await expect(page.getByText(/At least 2 distinct tracks with valid acoustic profiles are needed/)).toBeVisible();
});

test('Profile lists saved playlists and gives an honest path to create or join a Lounge', async ({ page }) => {
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill('Profile Lists E2E');
  await page.getByLabel('Email').fill(`profile-lists-${randomUUID()}@example.invalid`);
  await page.getByLabel('Password').fill(`ProfileList!${randomUUID()}9`);
  const registrationResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/register'));
  await page.getByRole('button', { name: 'Create Account' }).click();
  expect((await registrationResponse).status()).toBe(201);

  await page.getByRole('button', { name: 'New Playlist' }).click();
  await page.getByLabel('Playlist name').fill('Evening Set');
  await page.getByRole('dialog').getByRole('button', { name: 'Create Playlist', exact: true }).click();
  await page.goto('/profile');

  await expect(page.getByRole('heading', { name: 'Your Playlists' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Evening Set.*0 tracks.*Your playlist/ })).toBeVisible();
  await expect(page.getByText('6', { exact: true })).toBeVisible();
  await expect(page.getByText('0 tracks · Your playlist')).toBeVisible();
  await expect(page.getByText('No ended Lounge sessions yet')).toBeVisible();
  await page.getByRole('link', { name: 'Create or join a Lounge' }).click();
  await expect(page).toHaveURL(/\/queue$/);
  await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Lounge invite code' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join Lounge' })).toBeVisible();
});

test('Home category tabs navigate repeatedly, show active styling, and preserve browser history', async ({ page }) => {
  const tabs = page.getByRole('navigation', { name: 'Home categories' });
  const music = tabs.getByRole('link', { name: 'Music' });
  const podcasts = tabs.getByRole('link', { name: 'Podcasts' });
  const live = tabs.getByRole('link', { name: 'Live' });
  const radio = tabs.getByRole('link', { name: 'Radio' });

  await page.goto('/');
  await expect(music).toHaveClass(/selected/);
  await expect(page.getByRole('heading', { name: 'Artists in catalog' })).toBeVisible();

  await podcasts.click();
  await expect(page).toHaveURL(/\/podcasts$/);
  await expect(podcasts).toHaveClass(/selected/);
  await expect(page.getByRole('heading', { name: 'Podcasts', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: "NASA's Curious Universe" })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Episodes' })).toBeVisible();
  await expect(page.locator('.podcast-episode').first()).toBeVisible();

  await radio.click();
  await expect(page).toHaveURL(/\/radio$/);
  await expect(radio).toHaveClass(/selected/);
  await expect(page.getByRole('heading', { name: 'Radio', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'TheRadio.CC' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Listen live' })).toBeVisible();

  await live.click();
  await expect(page).toHaveURL(/\/queue$/);
  await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/radio$/);
  await expect(radio).toHaveClass(/selected/);
  await podcasts.click();
  await expect(podcasts).toHaveClass(/selected/);
  await music.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(music).toHaveClass(/selected/);
  await expect(page.getByRole('heading', { name: 'Artists in catalog' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/podcasts$/);
  await expect(podcasts).toHaveClass(/selected/);
  await page.goForward();
  await expect(page).toHaveURL(/\/$/);
  await expect(music).toHaveClass(/selected/);
});

test('Radio starts the published live stream through the persistent audio player', async ({ page }) => {
  await page.goto('/radio', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'TheRadio.CC' })).toBeVisible();
  await page.getByRole('button', { name: 'Listen live' }).click();
  const audio = page.locator('audio');
  await expect.poll(() => audio.evaluate((element) => !element.paused && element.readyState >= 2), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => audio.evaluate((element) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.5);
  await expect(page.getByText('Live radio · TheRadio.CC')).toBeVisible();
  const volume = page.getByRole('slider', { name: 'Volume' });
  await volume.click({ position: { x: 12, y: 10 } });
  await expect.poll(() => audio.evaluate((element) => element.volume)).toBeLessThan(0.3);
  await volume.click({ position: { x: 66, y: 10 } });
  await expect.poll(() => audio.evaluate((element) => element.volume)).toBeGreaterThan(0.65);
  await page.getByRole('button', { name: 'Mute' }).click();
  await expect.poll(() => audio.evaluate((element) => element.volume)).toBe(0);
  await page.getByRole('button', { name: 'Unmute' }).click();
  await expect.poll(() => audio.evaluate((element) => element.volume)).toBeGreaterThan(0.65);
  await page.locator('.player-play').click();
  await expect.poll(() => audio.evaluate((element) => element.paused)).toBe(true);
});

test('Podcast episode plays from the published feed through the persistent audio player', async ({ page }) => {
  const catalogResponse = await page.request.get('http://127.0.0.1:4317/api/v1/podcasts');
  expect(catalogResponse.ok(), `podcast endpoint failed: ${catalogResponse.status()} ${await catalogResponse.text()}`).toBe(true);
  await page.goto('/podcasts', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: "NASA's Curious Universe" })).toBeVisible({ timeout: 30_000 });
  const firstEpisode = page.locator('.podcast-episode').first();
  await expect(firstEpisode).toBeVisible();
  const episodeTitle = await firstEpisode.locator('.podcast-episode-copy b').innerText();
  const playEpisode = firstEpisode.getByRole('button', { name: /^Play / });
  await playEpisode.click();
  const audio = page.locator('audio');
  await expect.poll(() => audio.evaluate((element) => /(?:chrt\.fm|traffic\.megaphone\.fm)/.test(element.currentSrc) && element.readyState >= 1), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => audio.evaluate((element) => !element.paused && element.currentTime > 0.5), { timeout: 30_000 }).toBe(true);
  await expect(page.getByText('Podcast · NASA')).toBeVisible();
  await expect(page.locator('.player-song b')).toHaveText(episodeTitle);
  const seekTo = async (slider, targetSeconds) => {
    const duration = await audio.evaluate((element) => element.duration);
    expect(duration).toBeGreaterThan(targetSeconds);
    const box = await slider.boundingBox();
    await page.mouse.click(box.x + 6 + (box.width - 12) * targetSeconds / duration, box.y + box.height / 2);
    await expect.poll(() => audio.evaluate((element) => element.currentTime), { timeout: 10_000 }).toBeGreaterThan(targetSeconds - 8);
    await expect.poll(() => audio.evaluate((element) => element.currentTime), { timeout: 10_000 }).toBeLessThan(targetSeconds + 8);
  };
  const footerSeek = page.locator('.player .seek-slider');
  await expect(footerSeek).toBeEnabled();
  await seekTo(footerSeek, 120);
  await seekTo(footerSeek, 600);
  await page.getByRole('link', { name: 'Open Now Playing' }).click();
  const nowPlayingSeek = page.locator('.now-seek-slider');
  await expect(nowPlayingSeek).toBeEnabled();
  await seekTo(nowPlayingSeek, 120);
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect.poll(() => audio.evaluate((element) => element.paused)).toBe(true);
  await page.locator('.player-play').click();
  await expect.poll(() => audio.evaluate((element) => !element.paused && element.currentTime > 0.5), { timeout: 10_000 }).toBe(true);
});

test('notification button opens and closes the honest empty inbox state', async ({ page }) => {
  await page.goto('/');
  const notifications = page.getByRole('button', { name: 'Notifications', exact: true });
  await expect(notifications).toHaveAttribute('aria-expanded', 'false');
  await notifications.click();
  await expect(notifications).toHaveAttribute('aria-expanded', 'true');
  const panel = page.getByRole('region', { name: 'Notifications' });
  await expect(panel.getByText('You’re all caught up')).toBeVisible();
  await expect(panel.getByText('No notifications are available yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Close notifications' }).click();
  await expect(notifications).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(notifications).toBeVisible();
  await notifications.click();
  await expect(panel.getByText('No notifications are available yet.')).toBeVisible();
});

test('Now Playing offers real catalog tracks when opened without a selection', async ({ page }) => {
  await page.goto('/now-playing');
  await expect(page.getByRole('heading', { name: 'No track selected' })).toBeVisible();
  await expect(page.getByText('Choose a track from the AstraDJ catalog to load it into the player.')).toBeVisible();
  const selectTrack = page.getByRole('button', { name: 'Select Chill Beat' });
  await expect(selectTrack).toBeVisible();
  await expect(selectTrack).toContainText('Audio available');
  await selectTrack.click();
  await expect(page.getByRole('heading', { name: 'Chill Beat', exact: true })).toBeVisible();
  await expect(page.locator('.player-song b')).toHaveText('Chill Beat');
  await expect.poll(() => page.locator('audio').evaluate((element) => new URL(element.currentSrc).pathname)).toBe('/audio/chill-beat.ogg');
  await page.locator('.now-main .big-play').click();
  await expect.poll(() => page.locator('audio').evaluate((element) => element.currentTime), { timeout: 8000 }).toBeGreaterThan(0.3);
});

test('AI DJ voice input transcribes into the existing request field for review', async ({ page }) => {
  await page.addInitScript(() => {
    window.SpeechRecognition = class {
      start() {
        this.onstart?.();
        queueMicrotask(() => {
          this.onresult?.({ results: [[{ transcript: 'What is the current track BPM?' }]] });
          this.onend?.();
        });
      }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    };
  });
  await page.goto('/ai-dj');
  await page.getByRole('button', { name: 'Start voice input' }).click();
  await expect(page.getByLabel('Describe your mood')).toHaveValue('What is the current track BPM?');
  await expect(page.getByRole('status').filter({ hasText: 'Speech captured' })).toBeVisible();
});

test('AI DJ explains when this browser lacks speech recognition and keeps text input visible', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true });
    Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true });
  });
  await page.goto('/ai-dj');
  await expect(page.getByRole('button', { name: 'Start voice input' })).toBeDisabled();
  await expect(page.getByText('Voice input is not supported here. Type a request below.')).toBeVisible();
  await expect(page.getByLabel('Describe your mood')).toBeVisible();
});

test('AI DJ accepts a manual mood description without requiring a Lounge', async ({ page }) => {
  await page.goto('/ai-dj');
  const input = page.getByLabel('Describe your mood');
  await expect(input).toBeEnabled();
  await input.fill('I want something calm for a late-night drive');
  await page.getByRole('button', { name: 'Save mood note' }).click();
  const result = page.getByRole('status').filter({ hasText: 'Mood note saved for this session' });
  await expect(result).toContainText('I want something calm for a late-night drive');
  await expect(result).toContainText('Free-text notes are not yet used to change recommendations.');
});

test('Create Playlist controls create and restore a clearly local empty playlist', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create Playlist', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create playlist' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/saved in this browser only/i)).toBeVisible();
  const create = dialog.getByRole('button', { name: 'Create Playlist', exact: true });
  await expect(create).toBeDisabled();
  await dialog.getByLabel('Playlist name').fill('Night Drive Mix');
  await create.click();

  await expect(page).toHaveURL(/\/playlist\?playlist=/);
  await expect(page.getByRole('heading', { name: 'Night Drive Mix', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Chill Beat' })).toBeVisible();
  await expect(page.locator('.local-playlist-section').first()).toContainText('This playlist is empty. Add tracks from the catalog below.');
  const playlistLink = page.getByRole('link', { name: 'Night Drive Mix' });
  await expect(playlistLink).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Night Drive Mix', exact: true })).toBeVisible();
  await expect(playlistLink).toBeVisible();

  await page.getByRole('button', { name: 'New Playlist' }).click();
  await expect(page.getByRole('dialog', { name: 'Create playlist' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog', { name: 'Create playlist' })).toHaveCount(0);
});

test('sidebar starter mixes open with different songs and preserve playlist edits', async ({ page }) => {
  const expectedTracks = {
    'Chill Mix': ['Chill Beat', 'Night Drive', 'Blue Horizon'],
    'Workout Mix': ['Night Drive', 'Afterglow Avenue', 'Chill Beat'],
    'Lo-fi Beats': ['Thoughtness', 'Chill Beat', 'Night Drive'],
    'Focus Mode': ['Thoughtness', 'Blue Horizon', 'Afterglow Avenue'],
    'Party Hits': ['Night Drive', 'Afterglow Avenue', 'Chill Beat', 'Blue Horizon'],
  };
  const staleSharedTracks = ['t_2001', 't_2002', 't_2003', 't_cc0_chill_beat', 't_cc0_faded_fortress', 't_cc0_ivory_atlas', 't_cc0_thoughtness'];
  const legacyStarters = Object.entries(expectedTracks).map(([name]) => ({ id: `starter-${({ 'Chill Mix': 'chill', 'Workout Mix': 'workout', 'Lo-fi Beats': 'lofi', 'Focus Mode': 'focus', 'Party Hits': 'party' })[name]}`, name, starter: true, trackIds: staleSharedTracks }));
  await page.addInitScript((legacy) => {
    if (localStorage.getItem('__starter-playlist-migration-seeded')) return;
    localStorage.setItem('astradj:local-playlists:guest', JSON.stringify(legacy));
    localStorage.setItem('__starter-playlist-migration-seeded', 'yes');
  }, legacyStarters);
  await page.goto('/');
  const observedMixes = new Set();
  for (const [name, expected] of Object.entries(expectedTracks)) {
    await page.getByRole('link', { name, exact: true }).click();
    await expect(page).toHaveURL(/\/playlist\?playlist=/);
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    const rows = page.locator('.local-playlist-section').first().locator('.local-playlist-track-meta b');
    await expect(rows).toHaveCount(expected.length);
    const titles = await rows.allTextContents();
    expect(new Set(titles)).toEqual(new Set(expected));
    observedMixes.add([...titles].sort().join('|'));
    if (name !== Object.keys(expectedTracks).at(-1)) await page.goto('/');
  }
  expect(observedMixes.size).toBe(Object.keys(expectedTracks).length);

  await page.getByRole('link', { name: 'Chill Mix', exact: true }).click();
  await page.getByRole('button', { name: 'Add Thoughtness' }).click();
  await expect(page.getByRole('button', { name: 'Added Thoughtness' })).toBeDisabled();
  await expect(page.locator('.local-playlist-section').first()).toContainText('Thoughtness');
  await page.reload();
  await expect(page.locator('.local-playlist-section').first()).toContainText('Thoughtness');
  await page.getByRole('button', { name: 'Remove Thoughtness from playlist' }).click();
  await expect(page.locator('.local-playlist-section').first()).not.toContainText('Thoughtness');
  await expect(page.locator('.local-playlist-section').first().locator('.local-playlist-track-meta b')).toHaveCount(expectedTracks['Chill Mix'].length);
});
