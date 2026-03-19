/**
 * auth-setup.ts — Playwright global setup
 *
 * Creates a browser context with the QA bypass header, navigates to the
 * preview URL root to trigger cookie injection, and saves storage state
 * for all tests to reuse.
 */

import { chromium, FullConfig } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

const AUTH_DIR = path.join(process.cwd(), '.auth');
const STATE_FILE = path.join(AUTH_DIR, 'state.json');

async function globalSetup(config: FullConfig) {
  const qaToken = process.env.QA_BYPASS_SECRET || '';
  const baseURL = process.env.PREVIEW_URL || '';

  if (!baseURL) {
    console.log('[auth-setup] No PREVIEW_URL set — skipping auth setup');
    return;
  }

  // Ensure .auth directory exists
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    extraHTTPHeaders: {
      'X-QA-Agent-Token': qaToken,
    },
  });

  const page = await context.newPage();

  try {
    // Navigate to root to trigger QA bypass middleware cookie injection
    await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log('[auth-setup] Navigated to preview URL, saving storage state');
  } catch (err) {
    console.error('[auth-setup] Failed to navigate to preview URL:', err);
  }

  // Save storage state for test reuse
  await context.storageState({ path: STATE_FILE });
  console.log('[auth-setup] Storage state saved to', STATE_FILE);

  await browser.close();
}

export default globalSetup;
