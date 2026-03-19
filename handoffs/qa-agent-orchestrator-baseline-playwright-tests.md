<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- QA Agent Orchestrator + Baseline Playwright Tests

## Metadata
- **Branch:** `feat/qa-agent-orchestrator-baseline-playwright`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** .github/actions/tlm-qa-agent/run-qa.ts, .github/actions/tlm-qa-agent/tests/auth-setup.ts, .github/actions/tlm-qa-agent/tests/baseline.spec.ts, .github/actions/tlm-qa-agent/tests/api-health.spec.ts, .github/actions/tlm-qa-agent/playwright.config.ts

## Context

The `tlm-qa-agent` action exists as a stub at `.github/actions/tlm-qa-agent/`. The goal is to promote it from a stub to a fully operational QA orchestrator with a real Playwright test suite.

The action already has supporting utility modules:
- `smoke-test.ts` — runs smoke checks against core routes
- `parse-criteria.ts` — parses acceptance criteria from PR descriptions
- `format-comment.ts` — formats the final PR comment

The orchestrator (`run-qa.ts`) will wire these together, add Playwright execution via `execSync`, parse results, and post a formatted comment to the PR. The test suite covers two tiers: Tier 1 UI regression (`baseline.spec.ts`) and Tier 2 API infrastructure health (`api-health.spec.ts`).

Auth is handled via a global Playwright setup (`auth-setup.ts`) that injects a `X-QA-Agent-Token` header and saves storage state for reuse across tests. Exit code is always 0 (advisory mode — failures are reported as comments, not CI blockers).

**Concurrent work awareness:** A concurrent branch (`fix/show-github-actions-tlm-agents-in-dashboard-agent-`) is touching `app/(app)/agents/page.tsx`, `app/api/agents/tlm-agents/route.ts`, `components/tlm-agent-heartbeat.tsx`, and `lib/github.ts`. All files in this handoff live under `.github/actions/tlm-qa-agent/` — zero overlap. No coordination needed.

## Requirements

1. `run-qa.ts` orchestrates the full QA cycle: smoke tests → Playwright suite → result parsing → PR comment post.
2. `run-qa.ts` always exits with code 0 (advisory mode).
3. `tests/auth-setup.ts` creates a browser context with `X-QA-Agent-Token` header, navigates to `/`, and saves storage state to `.auth/state.json`.
4. `tests/baseline.spec.ts` (Tier 1) tests: dashboard heading/stats visible, agents page loads with agent cards, agents page shows trace viewer section, work items page loads with table/filters, pipeline page loads, no console errors on any page.
5. `tests/api-health.spec.ts` (Tier 2) tests: `/api/agents/traces`, `/api/events`, `/api/agents/heartbeats`, `/api/work-items`, `/api/agents/atc-metrics` all return non-5xx and return expected shapes.
6. `playwright.config.ts` sets `globalSetup` to `auth-setup.ts`, configures `storageState`, and sets `extraHTTPHeaders` with the QA bypass token.
7. Playwright results are written to `qa-results.json` and parsed by the orchestrator.
8. All new files live exclusively under `.github/actions/tlm-qa-agent/`.
9. Existing files (`smoke-test.ts`, `parse-criteria.ts`, `format-comment.ts`) are reused without modification unless a minor import/type fix is strictly required.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/qa-agent-orchestrator-baseline-playwright
```

### Step 1: Inspect existing stub files

Before writing any new code, read the existing files to understand their exports, types, and patterns:

```bash
ls .github/actions/tlm-qa-agent/
cat .github/actions/tlm-qa-agent/smoke-test.ts
cat .github/actions/tlm-qa-agent/parse-criteria.ts
cat .github/actions/tlm-qa-agent/format-comment.ts
cat .github/actions/tlm-qa-agent/action.yml
cat .github/actions/tlm-qa-agent/package.json 2>/dev/null || echo "no package.json"
cat .github/actions/tlm-qa-agent/tsconfig.json 2>/dev/null || echo "no tsconfig"
```

Note the exported function signatures. The orchestrator will import from these modules.

### Step 2: Ensure package.json and tsconfig exist

If `package.json` doesn't exist under `.github/actions/tlm-qa-agent/`, create it:

```json
{
  "name": "tlm-qa-agent",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "test": "playwright test",
    "test:baseline": "playwright test tests/baseline.spec.ts",
    "test:api": "playwright test tests/api-health.spec.ts"
  },
  "dependencies": {
    "@playwright/test": "^1.44.0",
    "typescript": "^5.0.0",
    "ts-node": "^10.9.0"
  }
}
```

If `tsconfig.json` doesn't exist:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

If these files already exist, merge the Playwright dependency in rather than replacing them.

### Step 3: Create `playwright.config.ts`

Create `.github/actions/tlm-qa-agent/playwright.config.ts`:

```typescript
import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const BASE_URL = process.env.DEPLOY_URL || process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3000';

const QA_TOKEN = process.env.QA_AGENT_TOKEN || '';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 1,
  workers: 1, // sequential to avoid auth race conditions
  reporter: [
    ['json', { outputFile: 'qa-results.json' }],
    ['list'],
  ],
  globalSetup: require.resolve('./tests/auth-setup'),
  use: {
    baseURL: BASE_URL,
    storageState: '.auth/state.json',
    extraHTTPHeaders: {
      'X-QA-Agent-Token': QA_TOKEN,
    },
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
```

### Step 4: Create `tests/auth-setup.ts`

Create `.github/actions/tlm-qa-agent/tests/auth-setup.ts`:

```typescript
import { chromium, FullConfig } from '@playwright/test';
import path from 'path';
import fs from 'fs';

async function globalSetup(config: FullConfig): Promise<void> {
  const { baseURL, extraHTTPHeaders } = config.projects[0].use;
  const qaToken = (extraHTTPHeaders as Record<string, string>)?.['X-QA-Agent-Token'] ?? '';

  // Ensure .auth directory exists
  const authDir = path.join(process.cwd(), '.auth');
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL: baseURL as string,
    extraHTTPHeaders: {
      'X-QA-Agent-Token': qaToken,
    },
  });

  const page = await context.newPage();

  // Navigate to root to trigger cookie/session injection via QA bypass middleware
  try {
    await page.goto('/', { waitUntil: 'networkidle', timeout: 20_000 });
  } catch {
    // Best-effort: if the page errors, still save state so tests can run
    console.warn('[auth-setup] Warning: navigation to / did not fully settle');
  }

  // Save storage state (cookies + localStorage) for reuse in tests
  await context.storageState({ path: '.auth/state.json' });

  await context.close();
  await browser.close();

  console.log('[auth-setup] Storage state saved to .auth/state.json');
}

export default globalSetup;
```

### Step 5: Create `tests/baseline.spec.ts`

Create `.github/actions/tlm-qa-agent/tests/baseline.spec.ts`:

```typescript
import { test, expect, Page, ConsoleMessage } from '@playwright/test';

// Collect console errors per page
function collectConsoleErrors(page: Page): ConsoleMessage[] {
  const errors: ConsoleMessage[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg);
    }
  });
  return errors;
}

test.describe('Tier 1 — UI Regression Baseline', () => {
  test('Dashboard loads: heading and stats visible', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/', { waitUntil: 'networkidle' });

    // Heading — adjust selector if the actual heading text differs
    const heading = page.getByRole('heading').first();
    await expect(heading).toBeVisible({ timeout: 10_000 });

    // Stats cards or pipeline summary — look for a numeric or stat element
    // Use a broad selector that should survive minor UI changes
    const statsArea = page.locator('[data-testid="stats"], .stats, main').first();
    await expect(statsArea).toBeVisible({ timeout: 10_000 });

    expect(errors, `Console errors on /: ${errors.map(e => e.text()).join(', ')}`).toHaveLength(0);
  });

  test('Agents page loads: agent cards visible', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/agents', { waitUntil: 'networkidle' });

    const heading = page.getByRole('heading').first();
    await expect(heading).toBeVisible({ timeout: 10_000 });

    // Agent cards — at least one card-like element should be present
    // The agents page shows dispatcher, health-monitor, project-manager, supervisor
    const agentCards = page.locator('[data-testid="agent-card"], .agent-card, [class*="card"]').first();
    await expect(agentCards).toBeVisible({ timeout: 10_000 });

    expect(errors, `Console errors on /agents: ${errors.map(e => e.text()).join(', ')}`).toHaveLength(0);
  });

  test('Agents page: trace viewer section visible', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/agents', { waitUntil: 'networkidle' });

    // Trace viewer section — look for heading or section containing "trace"
    const traceSection = page.getByText(/trace/i).first();
    await expect(traceSection).toBeVisible({ timeout: 10_000 });

    expect(errors, `Console errors on /agents (trace): ${errors.map(e => e.text()).join(', ')}`).toHaveLength(0);
  });

  test('Work Items page loads: table and filters visible', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/work-items', { waitUntil: 'networkidle' });

    const heading = page.getByRole('heading').first();
    await expect(heading).toBeVisible({ timeout: 10_000 });

    // Table or list — at least a table/list structure
    const tableOrList = page.locator('table, [role="table"], ul, [data-testid="work-items-list"]').first();
    await expect(tableOrList).toBeVisible({ timeout: 10_000 });

    // Filter controls — at least one select/input for filtering
    const filterControl = page.locator('select, input[type="search"], input[placeholder*="ilter"], [data-testid*="filter"]').first();
    await expect(filterControl).toBeVisible({ timeout: 10_000 });

    expect(errors, `Console errors on /work-items: ${errors.map(e => e.text()).join(', ')}`).toHaveLength(0);
  });

  test('Pipeline page loads', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/pipeline', { waitUntil: 'networkidle' });

    const heading = page.getByRole('heading').first();
    await expect(heading).toBeVisible({ timeout: 10_000 });

    expect(errors, `Console errors on /pipeline: ${errors.map(e => e.text()).join(', ')}`).toHaveLength(0);
  });
});
```

### Step 6: Create `tests/api-health.spec.ts`

Create `.github/actions/tlm-qa-agent/tests/api-health.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test.describe('Tier 2 — API Infrastructure Health', () => {
  async function fetchJson(request: import('@playwright/test').APIRequestContext, url: string) {
    const response = await request.get(url);
    return { status: response.status(), body: await response.json().catch(() => null) };
  }

  test('/api/agents/traces returns non-5xx with traces array', async ({ request }) => {
    const { status, body } = await fetchJson(request, '/api/agents/traces');
    expect(status, `/api/agents/traces returned ${status}`).toBeLessThan(500);
    if (status === 200 && body !== null) {
      // Should have a traces array or similar structure
      const hasTraces = Array.isArray(body) || Array.isArray(body?.traces) || typeof body === 'object';
      expect(hasTraces).toBe(true);
    }
  });

  test('/api/events returns non-5xx', async ({ request }) => {
    const { status } = await fetchJson(request, '/api/events');
    expect(status, `/api/events returned ${status}`).toBeLessThan(500);
  });

  test('/api/agents/heartbeats returns non-5xx', async ({ request }) => {
    const { status } = await fetchJson(request, '/api/agents/heartbeats');
    expect(status, `/api/agents/heartbeats returned ${status}`).toBeLessThan(500);
  });

  test('/api/work-items returns non-5xx', async ({ request }) => {
    const { status } = await fetchJson(request, '/api/work-items');
    expect(status, `/api/work-items returned ${status}`).toBeLessThan(500);
  });

  test('/api/agents/atc-metrics returns non-5xx', async ({ request }) => {
    const { status } = await fetchJson(request, '/api/agents/atc-metrics');
    expect(status, `/api/agents/atc-metrics returned ${status}`).toBeLessThan(500);
  });
});
```

### Step 7: Create `run-qa.ts`

First, re-read the exported signatures from `smoke-test.ts`, `parse-criteria.ts`, and `format-comment.ts`. Then create `.github/actions/tlm-qa-agent/run-qa.ts` that wires everything together.

The structure to implement:

```typescript
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Import from existing utility modules — adjust based on actual exports
// e.g.: import { runSmokeTests } from './smoke-test';
//       import { parseCriteria } from './parse-criteria';
//       import { formatComment } from './format-comment';

interface PlaywrightTestResult {
  status: 'passed' | 'failed' | 'skipped' | 'timedOut';
  title: string;
  error?: { message: string };
}

interface PlaywrightResults {
  stats?: {
    expected: number;
    skipped: number;
    unexpected: number;
    flaky: number;
  };
  suites?: Array<{
    title: string;
    suites?: PlaywrightResults['suites'];
    specs?: Array<{
      title: string;
      tests?: PlaywrightTestResult[];
    }>;
  }>;
}

async function main(): Promise<void> {
  const deployUrl = process.env.DEPLOY_URL || process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';
  const prNumber = process.env.PR_NUMBER;
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;

  console.log(`[run-qa] Starting QA cycle against ${deployUrl}`);
  console.log(`[run-qa] PR: ${prNumber ?? 'none'}`);

  // --- Phase 1: Smoke tests ---
  let smokeResults: unknown;
  try {
    // Import and run existing smoke tests
    // Adjust the import and call based on actual smoke-test.ts exports
    const { runSmokeTests } = await import('./smoke-test');
    smokeResults = await runSmokeTests(deployUrl);
    console.log('[run-qa] Smoke tests complete');
  } catch (err) {
    console.error('[run-qa] Smoke tests threw:', err);
    smokeResults = { error: String(err) };
  }

  // --- Phase 2: Playwright baseline suite ---
  let playwrightResults: PlaywrightResults | null = null;
  const resultsPath = path.join(process.cwd(), 'qa-results.json');

  try {
    // Clean previous results
    if (fs.existsSync(resultsPath)) {
      fs.unlinkSync(resultsPath);
    }

    console.log('[run-qa] Running Playwright suite...');
    execSync('npx playwright test --reporter=json', {
      stdio: 'inherit',
      env: {
        ...process.env,
        DEPLOY_URL: deployUrl,
      },
      // Don't throw on non-zero exit — advisory mode
    });
  } catch (err) {
    // Playwright exits non-zero on test failures — that's expected in advisory mode
    console.warn('[run-qa] Playwright exited non-zero (test failures recorded, continuing)');
  }

  // Parse results
  if (fs.existsSync(resultsPath)) {
    try {
      playwrightResults = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
      console.log('[run-qa] Parsed qa-results.json');
    } catch (err) {
      console.error('[run-qa] Failed to parse qa-results.json:', err);
    }
  } else {
    console.warn('[run-qa] qa-results.json not found after Playwright run');
  }

  // --- Phase 3: Parse acceptance criteria ---
  let acceptanceCriteria: string[] = [];
  if (prNumber && repo && token) {
    try {
      const { parseCriteria } = await import('./parse-criteria');
      // Fetch PR description
      const prApiUrl = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
      const prResponse = await fetch(prApiUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });
      if (prResponse.ok) {
        const prData = await prResponse.json() as { body?: string };
        acceptanceCriteria = parseCriteria(prData.body ?? '');
        console.log(`[run-qa] Parsed ${acceptanceCriteria.length} acceptance criteria`);
      }
    } catch (err) {
      console.error('[run-qa] Failed to fetch/parse acceptance criteria:', err);
    }
  }

  // --- Phase 4: Format and post comment ---
  if (prNumber && repo && token) {
    try {
      const { formatComment } = await import('./format-comment');
      const comment = formatComment({
        smokeResults,
        playwrightResults,
        acceptanceCriteria,
        deployUrl,
      });

      const commentUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
      const commentResponse = await fetch(commentUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: comment }),
      });

      if (commentResponse.ok) {
        console.log('[run-qa] Posted QA comment to PR');
      } else {
        const errText = await commentResponse.text();
        console.error(`[run-qa] Failed to post comment: ${commentResponse.status} ${errText}`);
      }
    } catch (err) {
      console.error('[run-qa] Failed to format/post comment:', err);
    }
  } else {
    console.log('[run-qa] No PR context — skipping comment (dry run)');
    console.log('[run-qa] Smoke results:', JSON.stringify(smokeResults, null, 2));
    console.log('[run-qa] Playwright results:', JSON.stringify(playwrightResults?.stats, null, 2));
  }

  // Advisory mode: always exit 0
  console.log('[run-qa] QA cycle complete (advisory mode — exit 0)');
  process.exit(0);
}

main().catch((err) => {
  console.error('[run-qa] Unhandled error in main:', err);
  // Still advisory mode
  process.exit(0);
});
```

**Critical:** After writing the above, re-read the actual exports in `smoke-test.ts`, `parse-criteria.ts`, and `format-comment.ts` and adjust the import names and call signatures to match exactly. Do not guess at function signatures — read the files.

### Step 8: Update `action.yml` if needed

Read `.github/actions/tlm-qa-agent/action.yml`. If the `runs.main` entrypoint is still pointing at a stub file, update it to point to `run-qa.ts` (via ts-node or compiled output). If it already points to a correct entrypoint, leave it alone.

Example of what the relevant section should look like if it uses ts-node:
```yaml
runs:
  using: 'node20'
  main: 'run-qa.js'  # or however it's currently wired
```

Only modify `action.yml` if the entrypoint needs to change to wire in `run-qa.ts`.

### Step 9: Verify TypeScript compiles

```bash
cd .github/actions/tlm-qa-agent
npx tsc --noEmit
```

Fix any type errors. Common issues to watch for:
- Import paths for existing utility modules (check actual filenames)
- `formatComment` argument shape — must match what `format-comment.ts` actually accepts
- `parseCriteria` return type — check if it returns `string[]` or an object

### Step 10: Verify from repo root

```bash
# TypeScript check from root (if root tsconfig includes actions)
npx tsc --noEmit

# Build check
npm run build
```

### Step 11: Commit, push, open PR

```bash
git add -A
git commit -m "feat: QA agent orchestrator + baseline Playwright test suite

- Add run-qa.ts orchestrating smoke tests → Playwright → comment posting
- Add tests/auth-setup.ts with X-QA-Agent-Token global auth setup
- Add tests/baseline.spec.ts (Tier 1 UI regression: 5 routes, console errors)
- Add tests/api-health.spec.ts (Tier 2 API health: 5 endpoints)
- Add playwright.config.ts with globalSetup, storageState, extraHTTPHeaders
- Advisory mode: always exits 0, failures reported as PR comments"

git push origin feat/qa-agent-orchestrator-baseline-playwright

gh pr create \
  --title "feat: QA agent orchestrator + baseline Playwright test suite" \
  --body "## Summary

Replaces the QA agent stub with a fully operational orchestrator and Playwright test suite.

## Changes

### Orchestrator (\`run-qa.ts\`)
- Runs smoke tests against core routes via existing \`smoke-test.ts\`
- Executes Playwright suite via \`execSync\`
- Parses \`qa-results.json\` results
- Fetches PR description and extracts acceptance criteria via \`parse-criteria.ts\`
- Posts formatted QA comment via \`format-comment.ts\`
- Always exits 0 (advisory mode)

### Auth Setup (\`tests/auth-setup.ts\`)
- Global Playwright setup
- Creates browser context with \`X-QA-Agent-Token\` header
- Navigates to \`/\` to trigger cookie injection
- Saves storage state to \`.auth/state.json\`

### Tier 1 Regression (\`tests/baseline.spec.ts\`)
- Dashboard heading + stats visible
- Agents page agent cards visible
- Agents page trace viewer section visible
- Work Items page table + filters visible
- Pipeline page loads
- No console errors on any page

### Tier 2 API Health (\`tests/api-health.spec.ts\`)
- \`/api/agents/traces\` non-5xx + traces shape
- \`/api/events\` non-5xx
- \`/api/agents/heartbeats\` non-5xx
- \`/api/work-items\` non-5xx
- \`/api/agents/atc-metrics\` non-5xx

### Config (\`playwright.config.ts\`)
- \`globalSetup\` → auth-setup
- \`storageState\` from \`.auth/state.json\`
- \`extraHTTPHeaders\` with QA bypass token
- JSON reporter → \`qa-results.json\`

## Acceptance Criteria
- [ ] run-qa.ts wires smoke → Playwright → parse → comment
- [ ] auth-setup.ts creates authenticated context and saves storage state
- [ ] baseline.spec.ts covers all 5 routes + console error checks
- [ ] api-health.spec.ts covers all 5 API endpoints
- [ ] playwright.config.ts uses globalSetup, storageState, extraHTTPHeaders
- [ ] TypeScript compiles without errors
- [ ] Advisory mode: always exits 0
- [ ] All files confined to .github/actions/tlm-qa-agent/"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/qa-agent-orchestrator-baseline-playwright
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you hit a blocker that cannot be resolved autonomously (e.g., `smoke-test.ts` exports are incompatible with the orchestrator design, `format-comment.ts` expects a shape that can't be derived from Playwright JSON output, or the action.yml wiring requires a build step not yet present):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "qa-agent-orchestrator-baseline-playwright",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": [
        ".github/actions/tlm-qa-agent/run-qa.ts",
        ".github/actions/tlm-qa-agent/playwright.config.ts",
        ".github/actions/tlm-qa-agent/tests/auth-setup.ts",
        ".github/actions/tlm-qa-agent/tests/baseline.spec.ts",
        ".github/actions/tlm-qa-agent/tests/api-health.spec.ts"
      ]
    }
  }'
```