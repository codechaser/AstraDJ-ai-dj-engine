import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

async function signInHost(page) {
  await page.goto('/profile', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(process.env.ASTRADJ_E2E_HOST_EMAIL);
  await page.getByLabel('Password').fill(process.env.ASTRADJ_E2E_HOST_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByRole('heading', { name: 'AstraDJ E2E Host' })).toBeVisible();
}

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
  const mongoose = (await import('../../server/node_modules/mongoose/index.js')).default;
  const { DJLounge } = await import('../../server/src/models/DJLounge.js');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    const storedLounge = await DJLounge.findOne({ loungeId: created.loungeId }).lean();
    expect(storedLounge).toMatchObject({
      loungeId: created.loungeId,
      inviteCode: created.inviteCode,
      currentTrackId: 't_2001',
      vibeProfile: 'After Work House',
      settings: { maxParticipants: 12, bpmTolerancePct: 6, soundclashEnabled: false, aiVerbosity: 'high' },
    });
  } finally {
    await mongoose.disconnect();
  }
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

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    const storedEndedLounge = await DJLounge.findOne({ loungeId: created.loungeId }).lean();
    expect(storedEndedLounge).toMatchObject({ status: 'ended', hostUserId: expect.anything(), endedAt: expect.any(Date), startedAt: expect.any(Date) });
    expect(storedEndedLounge.participantIds).toHaveLength(2);
    expect(storedEndedLounge.sessionSummary).toMatchObject({
      durationSeconds: expect.any(Number), queueEventCount: 0, soundclashBattles: 0,
      chatMessageCount: 0, sentimentTimeline: [], peakConcurrentParticipants: null, aiDjQuestionCount: null,
    });
    expect(await DJLounge.countDocuments({ loungeId: created.loungeId, status: 'ended' })).toBe(1);
  } finally {
    await mongoose.disconnect();
  }

  await hostPage.goto('/profile', { waitUntil: 'domcontentloaded' });
  await expect(hostPage.getByRole('heading', { name: 'Lounge History' })).toBeVisible();
  await expect(hostPage.getByText('After Work House', { exact: true })).toBeVisible();
  await listenerPage.goto('/profile', { waitUntil: 'domcontentloaded' });
  await expect(listenerPage.getByText('After Work House', { exact: true })).toBeVisible();

  const outsiderContext = await browser.newContext();
  const outsiderPage = await outsiderContext.newPage();
  outsiderPage.on('pageerror', (error) => pageErrors.push(error.message));
  await outsiderPage.goto('/profile', { waitUntil: 'domcontentloaded' });
  await outsiderPage.getByRole('button', { name: 'Create account' }).click();
  await outsiderPage.getByLabel('Display name').fill('Unrelated Account');
  await outsiderPage.getByLabel('Email').fill(`outsider-${randomUUID()}@example.invalid`);
  await outsiderPage.getByLabel('Password').fill(`Outsider!${randomUUID()}123`);
  await outsiderPage.getByRole('button', { name: 'Create Account' }).click();
  await expect(outsiderPage.getByRole('heading', { name: 'Unrelated Account' })).toBeVisible();
  await outsiderPage.goto('/');
  await outsiderPage.getByRole('link', { name: 'Live', exact: true }).click();
  await outsiderPage.getByRole('textbox', { name: 'Lounge invite code' }).fill(created.inviteCode);
  await outsiderPage.getByRole('button', { name: 'Join Lounge' }).click();
  await expect(outsiderPage.getByText('The Lounge invite code is invalid or expired')).toBeVisible();
  await outsiderPage.goto('/profile');
  await expect(outsiderPage.getByText('No ended Lounge sessions yet.')).toBeVisible();
  expect(pageErrors).toEqual([]);
  await outsiderContext.close();
  await listenerContext.close();
  await hostContext.close();
});
