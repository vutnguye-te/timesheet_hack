import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'html',
  timeout: 5 * 60 * 1000,

  use: {
    ...devices['Desktop Chrome'],
    headless: false,
    actionTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      args: ['--remote-debugging-port=9222'],
    },
  },

  projects: [
    {
      name: 'auth-setup',
      testMatch: 'auth.setup.ts',
    },
    {
      name: 'workday',
      testMatch: 'enter-oncall-time.spec.ts',
    },
  ],
});
