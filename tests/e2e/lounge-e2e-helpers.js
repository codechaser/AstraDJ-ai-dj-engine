import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';

export async function signInHost(page, {
  email = process.env.ASTRADJ_E2E_HOST_EMAIL,
  password = process.env.ASTRADJ_E2E_HOST_PASSWORD,
  displayName = 'AstraDJ E2E Host',
} = {}) {
  await page.goto('/profile', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByRole('heading', { name: displayName })).toBeVisible();
}

export async function registerListener(page, displayName) {
  await page.goto('/profile', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill(displayName);
  await page.getByLabel('Email').fill(`listener-${randomUUID()}@example.invalid`);
  await page.getByLabel('Password').fill(`Listener!${randomUUID()}123`);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(page.getByRole('heading', { name: displayName })).toBeVisible();
}

export async function createLounge(page, vibeProfile) {
  await page.goto('/queue', { waitUntil: 'domcontentloaded' });
  await page.getByRole('combobox', { name: 'Starting track' }).selectOption('t_2001');
  await page.getByRole('textbox', { name: 'Lounge vibe' }).fill(vibeProfile);
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/lounges') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Create Lounge' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const lounge = await response.json();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  return lounge;
}

export async function joinLounge(page, inviteCode) {
  await page.goto('/queue', { waitUntil: 'domcontentloaded' });
  await page.getByRole('textbox', { name: 'Lounge invite code' }).fill(inviteCode);
  await page.getByRole('button', { name: /^(Join Lounge|Reconnect)$/ }).click();
  await expect.poll(() => page.evaluate(() => {
    try { return JSON.parse(sessionStorage.getItem('astradj.activeLounge') ?? 'null')?.inviteCode ?? null; }
    catch { return null; }
  })).toBe(inviteCode);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Live Chat' })).toBeVisible();
  const history = page.getByRole('list', { name: 'Lounge chat messages' });
  await expect(page.getByText('No Lounge messages yet.').or(history.getByRole('listitem').first())).toBeVisible();
}
