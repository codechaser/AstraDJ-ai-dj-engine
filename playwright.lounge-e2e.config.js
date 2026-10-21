import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'lounge-create.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL: process.env.ASTRADJ_E2E_BASE_URL ?? 'http://127.0.0.1:4318',
    browserName: 'chromium',
    headless: true,
    launchOptions: { channel: 'chrome' },
    viewport: { width: 1440, height: 1000 },
  },
});
