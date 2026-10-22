import { expect, test } from '@playwright/test';

test('Admin can inspect and persist a profile from the catalog through the management UI', async ({ page }) => {
  await page.goto('/profile');
  await page.getByLabel('Email').fill(process.env.ASTRADJ_E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(process.env.ASTRADJ_E2E_ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByText(/Admin/).first()).toBeVisible();

  await page.goto('/admin/acoustic');
  await expect(page.getByRole('heading', { name: 'Acoustic Profiles' })).toBeVisible();
  const thoughtness = page.getByRole('button', { name: /Thoughtness.*t_cc0_thoughtness.*Profile missing/ });
  await expect(thoughtness).toBeVisible();
  await thoughtness.click();
  await expect(page.getByText('No acoustic profile saved')).toBeVisible();
  await expect(page.getByLabel('BPM')).toHaveValue('');

  await page.getByLabel('BPM').fill('130');
  await page.getByLabel('Camelot key').selectOption('10A');
  await page.getByLabel('Energy').fill('0');
  await page.getByLabel('Valence').fill('1');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByRole('status')).toContainText('Acoustic profile saved and available to matching.');
  await expect(page.getByRole('button', { name: /Thoughtness.*Profile saved/ })).toBeVisible();

  const profileResponse = await page.request.get('/api/v1/tracks/t_cc0_thoughtness/acoustic-profile');
  expect(profileResponse.ok()).toBe(true);
  expect(await profileResponse.json()).toMatchObject({
    trackId: 't_cc0_thoughtness', acoustic: { bpm: 130, camelotKey: '10A', energy: 0, valence: 1 },
  });

  await page.getByLabel('BPM').fill('128');
  await page.getByLabel('Camelot key').selectOption('9A');
  await page.getByLabel('Energy').fill('0.6');
  await page.getByLabel('Valence').fill('0.75');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByRole('status')).toContainText('Acoustic profile saved and available to matching.');
});
