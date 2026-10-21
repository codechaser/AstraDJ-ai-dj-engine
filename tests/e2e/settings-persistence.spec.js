import crypto from 'node:crypto';
import { expect, test } from '@playwright/test';

async function createAccount(page, { email, password, displayName }) {
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill(displayName);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(page.getByRole('heading', { name: displayName })).toBeVisible();
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Audio Settings' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Settings loaded from your account');
}

test('audio preferences persist through reload and login and remain isolated per account', async ({ page }) => {
  const suffix = crypto.randomUUID();
  const password = `test-${crypto.randomUUID()}-safe`;
  const firstEmail = `settings-a-${suffix}@example.invalid`;
  const secondEmail = `settings-b-${suffix}@example.invalid`;
  await createAccount(page, { email: firstEmail, password, displayName: 'Settings Listener A' });

  const quality = page.getByRole('combobox', { name: 'Streaming Quality' });
  const crossfade = page.getByRole('combobox', { name: 'Crossfade Songs' });
  const autoplay = page.getByRole('switch', { name: 'Auto Play' });
  await expect(quality).toHaveValue('High (320 kbps)');
  await quality.selectOption('Normal (160 kbps)');
  await expect(page.getByRole('status')).toHaveText('Saved to your account');
  await crossfade.selectOption('12');
  await expect(page.getByRole('status')).toHaveText('Saved to your account');
  await autoplay.click();
  await expect(autoplay).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('status')).toHaveText('Saved to your account');

  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Settings loaded from your account');
  await expect(quality).toHaveValue('Normal (160 kbps)');
  await expect(crossfade).toHaveValue('12');
  await expect(autoplay).toHaveAttribute('aria-checked', 'false');

  await page.goto('/profile');
  await page.getByRole('button', { name: 'Sign Out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.getByLabel('Email').fill(firstEmail);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByRole('heading', { name: 'Settings Listener A' })).toBeVisible();
  await page.goto('/settings');
  await expect(page.getByRole('combobox', { name: 'Streaming Quality' })).toHaveValue('Normal (160 kbps)');
  await expect(page.getByRole('combobox', { name: 'Crossfade Songs' })).toHaveValue('12');
  await expect(page.getByRole('switch', { name: 'Auto Play' })).toHaveAttribute('aria-checked', 'false');

  await page.goto('/profile');
  await page.getByRole('button', { name: 'Sign Out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await createAccount(page, { email: secondEmail, password, displayName: 'Settings Listener B' });
  await expect(page.getByRole('combobox', { name: 'Streaming Quality' })).toHaveValue('High (320 kbps)');
  await expect(page.getByRole('combobox', { name: 'Crossfade Songs' })).toHaveValue('6');
  await expect(page.getByRole('switch', { name: 'Auto Play' })).toHaveAttribute('aria-checked', 'true');
});

test('a failed preference update is shown as an error and does not report success', async ({ page }) => {
  const suffix = crypto.randomUUID();
  await createAccount(page, { email: `settings-fail-${suffix}@example.invalid`, password: `test-${crypto.randomUUID()}-safe`, displayName: 'Settings Failure' });
  await page.route('**/api/v1/auth/me/preferences', async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEMPORARY_FAILURE', message: 'Service temporarily unavailable' } }) });
      return;
    }
    await route.continue();
  });
  const autoplay = page.getByRole('switch', { name: 'Auto Play' });
  await autoplay.click();
  await expect(page.getByRole('status')).toHaveText('Service temporarily unavailable');
  await expect(autoplay).toHaveAttribute('aria-checked', 'true');
});
