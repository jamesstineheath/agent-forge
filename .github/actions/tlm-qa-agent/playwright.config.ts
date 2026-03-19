import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the TLM QA Agent.
 *
 * - baseURL is sourced from PREVIEW_URL environment variable (set by action.yml)
 * - globalSetup authenticates via QA bypass middleware
 * - Single Chromium project — no cross-browser testing needed for advisory QA
 * - 30s per-test timeout, 10s per-action timeout
 * - No retries — flakiness is reported, not masked
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './tests/auth-setup.ts',
  timeout: 30000,
  retries: 0,
  workers: 1,

  reporter: [
    ['list'],
    ['json', { outputFile: 'qa-results.json' }],
  ],

  use: {
    baseURL: process.env.PREVIEW_URL,
    storageState: '.auth/state.json',
    extraHTTPHeaders: {
      'X-QA-Agent-Token': process.env.QA_BYPASS_SECRET || '',
    },
    actionTimeout: 10000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
