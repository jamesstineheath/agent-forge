/**
 * baseline.spec.ts — Tier 1 Playwright regression suite
 *
 * Verifies core pages load without errors across the 4-agent architecture.
 */

import { test, expect } from '@playwright/test';

// Capture uncaught page errors for every test
let pageErrors: Error[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error);
  });
});

test.afterEach(async () => {
  expect(pageErrors, 'No console errors should be thrown').toHaveLength(0);
});

test.describe('Dashboard', () => {
  test('loads successfully', async ({ page }) => {
    await page.goto('/');
    // Dashboard should have a heading or stats content
    const content = page.locator('h1, h2, [data-testid="stats"], main');
    await expect(content.first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Agents page', () => {
  test('loads and shows agent cards', async ({ page }) => {
    await page.goto('/agents');

    // Verify agent cards for the 4-agent architecture
    const agentNames = ['Dispatcher', 'Health Monitor', 'Project Manager', 'Supervisor'];
    for (const name of agentNames) {
      const card = page.getByText(name, { exact: false });
      await expect(card.first()).toBeVisible({ timeout: 10000 });
    }
  });

  test('shows trace viewer section', async ({ page }) => {
    await page.goto('/agents');

    // Look for trace viewer elements
    const traceSection = page.locator(
      '[data-testid="trace-viewer"], text=/trace/i, [class*="trace"]'
    );
    await expect(traceSection.first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Work Items page', () => {
  test('loads and shows table or filter UI', async ({ page }) => {
    await page.goto('/work-items');

    // Should have a table, list, or filter UI
    const ui = page.locator(
      'table, [data-testid="work-items"], [role="table"], input[type="search"], select, [data-testid="filter"]'
    );
    await expect(ui.first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Pipeline page', () => {
  test('loads without error state', async ({ page }) => {
    await page.goto('/pipeline');

    // Should not show an error state
    const errorState = page.locator('text=/error|failed to load|something went wrong/i');
    await expect(errorState).toHaveCount(0, { timeout: 5000 });

    // Should have some content
    const content = page.locator('main, h1, h2, [data-testid="pipeline"]');
    await expect(content.first()).toBeVisible({ timeout: 10000 });
  });
});
