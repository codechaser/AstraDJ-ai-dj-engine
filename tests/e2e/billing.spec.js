import crypto from 'node:crypto';
import { expect, test } from '@playwright/test';

test('pricing page loads configured plans and does not expose checkout to signed-out visitors', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'View Premium plans' })).toBeVisible();
  await page.getByRole('link', { name: 'View Premium plans' }).click();
  await expect(page).toHaveURL(/\/plans$/);
  await expect(page.getByRole('heading', { name: 'Choose your plan' })).toBeVisible();
  for (const plan of ['Free', 'Premium', 'Pro']) await expect(page.locator('.plan-card').filter({ has: page.getByRole('heading', { name: plan, exact: true }) })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in to upgrade' })).toHaveCount(2);
  await expect(page.getByText(/Razorpay test credentials and this plan’s provider plan ID are required/)).toHaveCount(2);
  await expect(page.getByText(/Benefits marked “Planned” are not enabled/)).toBeVisible();
});

test('new account sees its server-derived Free plan and empty verified payment history', async ({ page }) => {
  const suffix = crypto.randomUUID();
  const email = `billing-e2e-${suffix}@example.invalid`;
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill('Billing E2E Listener');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(`test-${crypto.randomUUID()}-safe`);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(page.getByRole('heading', { name: 'Billing E2E Listener' })).toBeVisible();

  await page.goto('/plans');
  await expect(page.getByRole('button', { name: 'Get Premium' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Get Pro' })).toBeVisible();
  await page.getByRole('button', { name: 'Get Premium' }).click();
  await expect(page.getByRole('dialog', { name: 'Premium checkout isn’t ready yet' })).toBeVisible();
  await expect(page.getByText('No payment was started or taken. Your current plan remains unchanged.')).toBeVisible();
  await page.getByRole('button', { name: 'Got it' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.goto('/settings/billing');
  await expect(page.getByRole('heading', { name: 'Billing & subscription' })).toBeVisible();
  await expect(page.locator('.billing-current').getByRole('heading', { name: 'Free' })).toBeVisible();
  await expect(page.getByText('No payments yet')).toBeVisible();
  await expect(page.getByText('Verified Razorpay transactions will appear here.')).toBeVisible();
});
