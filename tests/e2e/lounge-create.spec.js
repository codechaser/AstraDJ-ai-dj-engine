import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import mongoose from '../../server/node_modules/mongoose/index.js';
import { DJLounge } from '../../server/src/models/DJLounge.js';
import { QueueEvent } from '../../server/src/models/QueueEvent.js';
import { registerListener, signInHost } from './lounge-e2e-helpers.js';

test.beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
});

test.afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

test('Host creates a Lounge from the catalog and another authenticated listener joins by invite', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const hostPage = await hostContext.newPage();
  const pageErrors = [];
  hostPage.on('pageerror', (error) => pageErrors.push(error.message));
  await signInHost(hostPage);
  await hostPage.goto('/', { waitUntil: 'domcontentloaded' });
  await hostPage.getByRole('link', { name: 'Live', exact: true }).click();
  const starter = hostPage.getByRole('combobox', { name: 'Starting track' });
  await expect(starter.locator('option[value="t_2001"]')).toHaveText('Night Drive · Nova Circuit');
  await starter.selectOption('t_2001');
  await hostPage.getByRole('textbox', { name: 'Lounge vibe' }).fill('After Work House');
  await hostPage.getByLabel('Lounge capacity').selectOption('12');
  await hostPage.getByLabel('BPM tolerance').selectOption('6');
  await hostPage.getByLabel('AI DJ verbosity').selectOption('high');
  await hostPage.getByLabel('Enable Soundclash').uncheck();

  const createResponse = hostPage.waitForResponse((response) =>
    response.url().endsWith('/api/v1/lounges') && response.request().method() === 'POST',
  );
  await hostPage.getByRole('button', { name: 'Create Lounge' }).click();
  const response = await createResponse;
  expect(response.status()).toBe(201);
  const created = await response.json();
  expect(created).toMatchObject({ status: 'scheduled', hostUserId: expect.any(String) });
  expect(created.inviteCode).toMatch(/^SP-[A-HJ-NP-Z2-9]{4}$/);
  expect(await response.request().postDataJSON()).toMatchObject({
    seedTrackId: 't_2001', vibeProfile: 'After Work House', maxParticipants: 12,
    bpmTolerancePct: 6, soundclashEnabled: false, aiVerbosity: 'high',
  });
  const storedLounge = await DJLounge.findOne({ loungeId: created.loungeId }).lean();
  expect(storedLounge).toMatchObject({
    loungeId: created.loungeId,
    inviteCode: created.inviteCode,
    currentTrackId: 't_2001',
    vibeProfile: 'After Work House',
    settings: { maxParticipants: 12, bpmTolerancePct: 6, soundclashEnabled: false, aiVerbosity: 'high' },
  });
  await expect(hostPage.getByText(`Lounge created. Invite code: ${created.inviteCode}`)).toBeVisible();
  await expect(hostPage.getByText('Live', { exact: true })).toBeVisible();
  await expect(hostPage.getByRole('main').getByText('Night Drive', { exact: true })).toBeVisible();
  await expect.poll(() => hostPage.evaluate(() => sessionStorage.getItem('astradj.activeLounge'))).toContain(created.inviteCode);

  await hostPage.goto('/profile', { waitUntil: 'domcontentloaded' });
  await expect(hostPage.getByRole('heading', { name: 'AstraDJ E2E Host' })).toBeVisible();
  await expect.poll(() => hostPage.evaluate(() => sessionStorage.getItem('astradj.activeLounge'))).toContain(created.inviteCode);
  await hostPage.goto('/queue', { waitUntil: 'domcontentloaded' });
  const rejoin = hostPage.getByRole('button', { name: `Rejoin your recent Lounge · ${created.inviteCode}` });
  await expect(rejoin).toBeVisible();
  await rejoin.click();
  await expect(hostPage.getByText('Live', { exact: true })).toBeVisible();
  await expect(hostPage.getByRole('main').getByText('Night Drive', { exact: true })).toBeVisible();

  const listenerContext = await browser.newContext();
  const listenerPage = await listenerContext.newPage();
  listenerPage.on('pageerror', (error) => pageErrors.push(error.message));
  await listenerPage.goto('/profile', { waitUntil: 'domcontentloaded' });
  await listenerPage.getByRole('button', { name: 'Create account' }).click();
  await listenerPage.getByLabel('Display name').fill('Lounge Guest');
  await listenerPage.getByLabel('Email').fill(`guest-${randomUUID()}@example.invalid`);
  await listenerPage.getByLabel('Password').fill(`Guest!${randomUUID()}123`);
  await listenerPage.getByRole('button', { name: 'Create Account' }).click();
  await expect(listenerPage.getByRole('heading', { name: 'Lounge Guest' })).toBeVisible();
  await listenerPage.goto('/', { waitUntil: 'domcontentloaded' });
  await listenerPage.getByRole('link', { name: 'Live', exact: true }).click();
  await listenerPage.getByRole('textbox', { name: 'Lounge invite code' }).fill(created.inviteCode);
  await listenerPage.getByRole('button', { name: 'Join Lounge' }).click();
  await expect(listenerPage.getByText('Live', { exact: true })).toBeVisible();
  await expect(listenerPage.getByRole('main').getByText('Night Drive', { exact: true })).toBeVisible();

  hostPage.on('dialog', (dialog) => dialog.accept());
  await hostPage.getByRole('button', { name: 'End Lounge' }).click();
  await expect(hostPage.getByText('Ended', { exact: true })).toBeVisible();
  await expect(hostPage.getByText(/Lounge session ended\./)).toBeVisible();
  await expect(listenerPage.getByText('Ended', { exact: true })).toBeVisible();
  await expect(listenerPage.getByText(/Lounge session ended\./)).toBeVisible();

  const storedEndedLounge = await DJLounge.findOne({ loungeId: created.loungeId }).lean();
  expect(storedEndedLounge).toMatchObject({ status: 'ended', hostUserId: expect.anything(), endedAt: expect.any(Date), startedAt: expect.any(Date) });
  expect(storedEndedLounge.participantIds).toHaveLength(2);
  expect(storedEndedLounge.sessionSummary).toMatchObject({
    durationSeconds: expect.any(Number), queueEventCount: 0, soundclashBattles: 0,
    chatMessageCount: 0, sentimentTimeline: [], peakConcurrentParticipants: 2, aiDjQuestionCount: 0, unavailableMetrics: {},
  });
  expect(await DJLounge.countDocuments({ loungeId: created.loungeId, status: 'ended' })).toBe(1);

  await hostPage.goto('/profile', { waitUntil: 'domcontentloaded' });
  await expect(hostPage.getByRole('heading', { name: 'Lounge History' })).toBeVisible();
  await expect(hostPage.getByText('After Work House', { exact: true })).toBeVisible();
  await expect(hostPage.getByText('Peak 2 · 0 AI questions · 0 sentiment samples')).toBeVisible();
  await listenerPage.goto('/profile', { waitUntil: 'domcontentloaded' });
  await expect(listenerPage.getByText('After Work House', { exact: true })).toBeVisible();
  await expect(listenerPage.getByText('Peak 2 · 0 AI questions · 0 sentiment samples')).toBeVisible();

  const outsiderContext = await browser.newContext();
  const outsiderPage = await outsiderContext.newPage();
  outsiderPage.on('pageerror', (error) => pageErrors.push(error.message));
  await outsiderPage.goto('/profile', { waitUntil: 'domcontentloaded' });
  await outsiderPage.getByRole('button', { name: 'Create account' }).click();
  await outsiderPage.getByLabel('Display name').fill('Unrelated Account');
  await outsiderPage.getByLabel('Email').fill(`outsider-${randomUUID()}@example.invalid`);
  await outsiderPage.getByLabel('Password').fill(`Outsider!${randomUUID()}123`);
  const registrationResponse = outsiderPage.waitForResponse((response) => response.url().endsWith('/api/v1/auth/register') && response.request().method() === 'POST');
  await outsiderPage.getByRole('button', { name: 'Create Account' }).click();
  const registered = await registrationResponse;
  const registrationResult = await registered.json().catch(() => ({}));
  console.info(`[auth-e2e] outsider registration status=${registered.status()} displayName=${registrationResult.user?.displayName ?? 'none'} error=${registrationResult.error?.code ?? 'none'}`);
  expect(registered.status()).toBe(201);
  await expect(outsiderPage.getByRole('heading', { name: 'Unrelated Account' })).toBeVisible();
  await outsiderPage.goto('/', { waitUntil: 'domcontentloaded' });
  await outsiderPage.getByRole('link', { name: 'Live', exact: true }).click();
  await outsiderPage.getByRole('textbox', { name: 'Lounge invite code' }).fill(created.inviteCode);
  await outsiderPage.getByRole('button', { name: 'Join Lounge' }).click();
  await expect(outsiderPage.getByText('The Lounge invite code is invalid or expired')).toBeVisible();
  await outsiderPage.goto('/profile', { waitUntil: 'domcontentloaded' });
  await expect(outsiderPage.getByText('No ended Lounge sessions yet.')).toBeVisible();
  expect(pageErrors).toEqual([]);
  await outsiderContext.close();
  await listenerContext.close();
  await hostContext.close();
});

test('two Listener submissions automatically open a persisted Soundclash and live vote totals match Mongo', async ({ browser, page }) => {
  test.setTimeout(60_000);
  await signInHost(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: 'Live', exact: true }).click();
  await page.getByRole('combobox', { name: 'Starting track' }).selectOption('t_2001');
  await page.getByLabel('Enable Soundclash').check();
  await page.getByRole('button', { name: 'Create Lounge' }).click();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Choose a catalog track to add' }).selectOption('t_2002');
  await page.getByRole('button', { name: 'Add to queue' }).click();
  await expect(page.getByRole('main').getByText('Blue Horizon', { exact: true })).toBeVisible();
  const { loungeId, inviteCode } = await page.evaluate(() => JSON.parse(sessionStorage.getItem('astradj.activeLounge')));

  const listenerContexts = [await browser.newContext(), await browser.newContext()];
  const listeners = await Promise.all(listenerContexts.map((context, index) => context.newPage()));
  await registerListener(listeners[0], 'Soundclash Listener One');
  await registerListener(listeners[1], 'Soundclash Listener Two');
  for (const listenerPage of listeners) {
    await listenerPage.goto('/', { waitUntil: 'domcontentloaded' });
    await listenerPage.getByRole('link', { name: 'Live', exact: true }).click();
    await listenerPage.getByRole('textbox', { name: 'Lounge invite code' }).fill(inviteCode);
    await listenerPage.getByRole('button', { name: 'Join Lounge' }).click();
    await expect(listenerPage.getByText('Live', { exact: true })).toBeVisible();
  }
  await listeners[0].getByRole('combobox', { name: 'Choose a track to submit to Soundclash' }).selectOption('t_cc0_thoughtness');
  await listeners[0].getByRole('button', { name: 'Submit track' }).click();
  await expect(page.getByText('The AI DJ opens a timed vote automatically when the second Listener entry arrives.')).toBeVisible();
  await listeners[1].getByRole('combobox', { name: 'Choose a track to submit to Soundclash' }).selectOption('t_cc0_chill_beat');
  await listeners[1].getByRole('button', { name: 'Submit track' }).click();

  await expect(page.locator('.soundclash-panel .muted')).toHaveText('open');
  await expect(page.getByText(/Voting closes in/)).toBeVisible();
  await expect(listeners[0].locator('.soundclash-candidate')).toHaveCount(2);
  const thoughtnessCandidate = listeners[0].locator('.soundclash-candidate').filter({ hasText: 'Thoughtness' });
  await thoughtnessCandidate.getByRole('button', { name: 'Vote' }).click();
  await expect(thoughtnessCandidate).toContainText('1 votes');
  await expect(listeners[1].locator('.soundclash-candidate').filter({ hasText: 'Thoughtness' })).toContainText('1 votes');

  try {
    const events = await QueueEvent.find({ loungeId }).sort({ seq: 1 }).lean();
    expect(events.map(({ type }) => type)).toEqual(expect.arrayContaining(['soundclash.submitted', 'soundclash.opened', 'soundclash.voted']));
    expect(events.filter(({ type }) => type === 'soundclash.submitted')).toHaveLength(2);
    const opened = events.find(({ type }) => type === 'soundclash.opened');
    expect(opened).toMatchObject({ actorUserId: null, payload: { openedBy: 'ai_dj', candidateTrackIds: ['t_cc0_thoughtness', 't_cc0_chill_beat'] } });
    const vote = events.find(({ type }) => type === 'soundclash.voted');
    expect(vote).toMatchObject({ payload: { battleId: opened.payload.battleId, trackId: 't_cc0_thoughtness' } });
  } finally {
    await Promise.all(listenerContexts.map((context) => context.close()));
  }
});
