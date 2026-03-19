/**
 * api-health.spec.ts — Tier 2 API infrastructure health
 *
 * Verifies API endpoints return non-5xx responses with valid JSON.
 * Accepts 401 (auth required) but fails on 5xx.
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

test.describe('API Health', () => {
  test('/api/agents/traces returns non-5xx with traces array', async ({ page }) => {
    const response = await page.request.get('/api/agents/traces');
    expect(response.status(), 'Should not be 5xx').toBeLessThan(500);

    if (response.status() < 400) {
      const body = await response.json();
      expect(body).toHaveProperty('traces');
      expect(Array.isArray(body.traces)).toBe(true);
    }
    // 401 is acceptable — auth required
  });

  test('/api/events returns non-5xx with JSON', async ({ page }) => {
    const response = await page.request.get('/api/events');
    expect(response.status(), 'Should not be 5xx').toBeLessThan(500);

    if (response.status() < 400) {
      const body = await response.json();
      expect(body).toBeDefined();
    }
  });

  test('/api/work-items returns non-5xx with valid JSON', async ({ page }) => {
    const response = await page.request.get('/api/work-items');
    expect(response.status(), 'Should not be 5xx').toBeLessThan(500);

    if (response.status() < 400) {
      const body = await response.json();
      expect(body).toBeDefined();
    }
  });

  test('/api/agents/atc-metrics returns non-5xx with metrics object', async ({ page }) => {
    const response = await page.request.get('/api/agents/atc-metrics');
    expect(response.status(), 'Should not be 5xx').toBeLessThan(500);

    if (response.status() < 400) {
      const body = await response.json();
      expect(typeof body).toBe('object');
    }
  });
});
