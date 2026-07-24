import { defineConfig } from '@playwright/test';

export default defineConfig({
  expect: {
    timeout: 5_000,
  },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  outputDir: 'test-results',
  reporter: process.env.CI ? [['line']] : [['list']],
  retries: process.env.CI ? 1 : 0,
  testDir: './e2e',
  timeout: 30_000,
  use: {
    trace: 'retain-on-failure',
  },
  workers: 1,
});
