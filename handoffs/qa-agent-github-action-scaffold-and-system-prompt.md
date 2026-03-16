# Agent Forge -- QA Agent GitHub Action Scaffold and System Prompt

## Metadata
- **Branch:** `feat/tlm-qa-agent-scaffold`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** .github/actions/tlm-qa-agent/action.yml, .github/actions/tlm-qa-agent/system-prompt.md, .github/actions/tlm-qa-agent/playwright.config.ts

## Context

Agent Forge is a dev orchestration control plane (Next.js on Vercel) that coordinates autonomous agent teams. The data plane in each target repo includes a set of TLM (Tool-augmented Language Model) agents implemented as GitHub Actions composite actions. Existing examples include:
- `.github/actions/tlm-review/` — PR code reviewer
- `.github/actions/tlm-spec-review/` — Handoff spec improver
- `.github/actions/tlm-outcome-tracker/` — Daily outcome assessor

This task adds a new TLM agent: the **QA Agent** (`tlm-qa-agent`). It will use Playwright to run browser-based verification against Vercel preview URLs when PRs are opened. The agent operates in advisory mode — it posts a comment with its findings but never blocks a merge.

The TypeScript entrypoint (`run-qa.ts`) will be added in a subsequent work item. This task only creates the scaffold: `action.yml`, `system-prompt.md`, and `playwright.config.ts`.

## Requirements

1. `.github/actions/tlm-qa-agent/action.yml` must exist and be valid YAML parseable by GitHub Actions
2. `action.yml` must declare composite action inputs: `preview-url`, `pr-number`, `repo`, `anthropic-api-key`, `qa-bypass-secret`, `github-token`
3. `action.yml` steps must include: setup Node 20, restore Playwright browser cache via `actions/cache` with a key based on Playwright version, install npm dependencies, install Playwright browsers, and run the QA agent script (`run-qa.ts` via `npx ts-node`)
4. The cache key for Playwright browsers must be based on the Playwright package version (e.g., using `$(node -e "require('@playwright/test/package.json').version"`)`)
5. `.github/actions/tlm-qa-agent/system-prompt.md` must contain the three-pass verification strategy: Pass 1 (smoke test), Pass 2 (acceptance criteria verification), Pass 3 (regression placeholder)
6. `system-prompt.md` must include an output format template specifying how the agent should structure its GitHub PR comment
7. `system-prompt.md` must define classification guidance for criteria types: HTTP-verifiable, Playwright-verifiable, not-verifiable
8. `system-prompt.md` must document timeout rules (30s per script/action, 10s per action step) and advisory-mode behavior (never blocks merge)
9. `.github/actions/tlm-qa-agent/playwright.config.ts` must configure a single Chromium project with `baseURL` sourced from `process.env.PREVIEW_URL`
10. `playwright.config.ts` must set `timeout: 30000` (per test) and `actionTimeout: 10000` in `use`
11. `playwright.config.ts` must set `retries: 0`

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/tlm-qa-agent-scaffold
```

### Step 1: Create the action.yml composite action

Create `.github/actions/tlm-qa-agent/action.yml`:

```yaml
name: TLM QA Agent
description: >
  Playwright-based QA agent that verifies PRs against Vercel preview URLs
  and posts advisory findings as a PR comment. Never blocks merges.

inputs:
  preview-url:
    description: 'Vercel preview deployment URL to test against'
    required: true
  pr-number:
    description: 'Pull request number'
    required: true
  repo:
    description: 'Repository in owner/name format'
    required: true
  anthropic-api-key:
    description: 'Anthropic API key for Claude'
    required: true
  qa-bypass-secret:
    description: 'Secret token to skip QA checks when set in PR body'
    required: false
    default: ''
  github-token:
    description: 'GitHub token for posting PR comments'
    required: true

runs:
  using: composite
  steps:
    - name: Setup Node.js 20
      uses: actions/setup-node@v4
      with:
        node-version: '20'

    - name: Get Playwright version
      id: playwright-version
      shell: bash
      run: |
        PLAYWRIGHT_VERSION=$(node -e "console.log(require('./node_modules/@playwright/test/package.json').version)" 2>/dev/null || echo "latest")
        echo "version=${PLAYWRIGHT_VERSION}" >> $GITHUB_OUTPUT

    - name: Restore Playwright browser cache
      uses: actions/cache@v4
      id: playwright-cache
      with:
        path: ~/.cache/ms-playwright
        key: playwright-browsers-${{ steps.playwright-version.outputs.version }}

    - name: Install dependencies
      shell: bash
      working-directory: ${{ github.action_path }}
      run: npm ci --prefer-offline

    - name: Install Playwright browsers
      if: steps.playwright-cache.outputs.cache-hit != 'true'
      shell: bash
      working-directory: ${{ github.action_path }}
      run: npx playwright install chromium --with-deps

    - name: Run QA Agent
      shell: bash
      working-directory: ${{ github.action_path }}
      env:
        PREVIEW_URL: ${{ inputs.preview-url }}
        PR_NUMBER: ${{ inputs.pr-number }}
        REPO: ${{ inputs.repo }}
        ANTHROPIC_API_KEY: ${{ inputs.anthropic-api-key }}
        QA_BYPASS_SECRET: ${{ inputs.qa-bypass-secret }}
        GITHUB_TOKEN: ${{ inputs.github-token }}
      run: npx ts-node run-qa.ts
```

### Step 2: Create the system-prompt.md

Create `.github/actions/tlm-qa-agent/system-prompt.md`:

```markdown
# TLM QA Agent — System Prompt

You are the QA Agent for Agent Forge, a Playwright-powered browser automation agent that verifies pull request changes against Vercel preview deployments. Your findings are **advisory only** — you never block a merge.

## Role and Responsibility

You receive:
- A Vercel preview URL for the PR under review
- The PR title, description, and list of changed files
- Any acceptance criteria extracted from the PR body or linked work item

Your job is to execute a structured three-pass verification and report results as a well-formatted GitHub PR comment.

---

## Three-Pass Verification Strategy

### Pass 1: Smoke Test

**Goal:** Confirm the preview deployment is reachable and renders without critical errors.

Steps:
1. Navigate to the `PREVIEW_URL` root path
2. Assert HTTP status is 200 (or redirect to an auth page is acceptable)
3. Assert the page body is not empty and does not contain a Vercel error page
4. Check the browser console for JavaScript errors (log warnings, fail on uncaught exceptions)
5. Record load time

**Pass 1 succeeds** if the page loads without server errors or uncaught JS exceptions.
**Pass 1 fails** if the URL returns 4xx/5xx, the page is blank, or there is a Vercel deployment error banner.

If Pass 1 fails, skip Passes 2 and 3 and report `DEPLOYMENT_UNREACHABLE`.

---

### Pass 2: Acceptance Criteria Verification

**Goal:** Verify each acceptance criterion from the PR that is testable via browser.

For each acceptance criterion:
1. Classify it (see Classification Guidance below)
2. If `HTTP-verifiable` or `Playwright-verifiable`, execute the verification
3. If `not-verifiable`, mark it as skipped with a reason
4. Record: criterion text, classification, result (PASS / FAIL / SKIP), and a one-sentence observation

**Common verification patterns:**
- **Page exists:** Navigate to the route, assert 200 and non-empty body
- **UI element present:** Use Playwright locator to assert element visibility
- **Form interaction:** Fill and submit a form, assert success state
- **API response:** Use `page.request.get()` to check JSON endpoints
- **Navigation flow:** Click through a user journey, assert final URL/state

---

### Pass 3: Regression Placeholder

**Goal:** Confirm no obvious regressions in core flows adjacent to the changed files.

> **Note:** Full regression suite is not yet implemented. This pass is a placeholder.

Steps:
1. Identify the 2-3 most critical paths in the application based on changed files
2. Navigate to each critical path's entry point
3. Assert the page loads without errors (smoke-level only)
4. Log which paths were checked

This pass always produces an advisory result — PASS means no obvious regressions detected, not that regressions are impossible.

---

## Classification Guidance

When classifying each acceptance criterion, use these categories:

### `HTTP-verifiable`
The criterion can be verified by checking an HTTP response (status code, response body, headers) without full browser rendering.

Examples:
- "API endpoint returns 200"
- "Redirect from /old to /new works"
- "JSON response contains expected field"

### `Playwright-verifiable`
The criterion requires a real browser context to verify (DOM interaction, visual rendering, JavaScript execution, form submission).

Examples:
- "Button appears on the dashboard"
- "Modal opens when clicking the trigger"
- "Form validation shows error message on empty submit"
- "Page title is correct"

### `not-verifiable`
The criterion cannot be confirmed via browser automation. Do not attempt to fake verification.

Examples:
- "Code is well-organized" (subjective/structural)
- "Database migration runs correctly" (backend-only)
- "TypeScript types are correct" (compile-time only)
- "Unit tests pass" (CI-level, not browser-level)
- "Environment variable is set" (server-side only)

---

## Timeout Rules

- **Per-test timeout:** 30 seconds (`timeout: 30000` in Playwright config)
- **Per-action timeout:** 10 seconds (`actionTimeout: 10000` in Playwright config `use`)
- If a test exceeds its timeout, mark it as FAIL with reason `TIMEOUT`
- Do not retry failed tests (`retries: 0`)
- If the entire QA run exceeds 5 minutes, abort and report partial results

---

## Advisory Mode Behavior

You operate in **advisory mode**. This means:

1. **Never fail the GitHub Actions workflow** with a non-zero exit code based on QA findings
2. **Always post a comment** — even if all checks pass, even if the deployment is unreachable
3. **Do not request changes** on the PR — post an informational comment only
4. **Surface blockers as warnings**, not merge gates
5. If `QA_BYPASS_SECRET` is present in the PR body (format: `qa-bypass: <secret>`), skip all Playwright checks and post a bypass acknowledgment comment

---

## Output Format Specification

Post a single GitHub PR comment with the following structure:

```
## 🤖 TLM QA Agent Report

**Preview URL:** <url>
**Tested at:** <ISO timestamp>
**Overall Status:** ✅ PASS | ⚠️ PARTIAL | ❌ FAIL | 🚫 UNREACHABLE | ⏭️ BYPASSED

---

### Pass 1: Smoke Test
- **Status:** PASS / FAIL
- **Load time:** Xms
- **Notes:** <any console errors or warnings>

---

### Pass 2: Acceptance Criteria

| Criterion | Type | Result | Notes |
|-----------|------|--------|-------|
| <criterion text> | HTTP-verifiable | ✅ PASS | <observation> |
| <criterion text> | Playwright-verifiable | ✅ PASS | <observation> |
| <criterion text> | not-verifiable | ⏭️ SKIP | Cannot verify via browser |

---

### Pass 3: Regression Check (Advisory)
- **Paths checked:** <list>
- **Status:** No obvious regressions detected / Issues found (see below)
- **Notes:** <observations>

---

### Summary
<2-3 sentence narrative summary of findings. Highlight any failures or concerns. Remind that this report is advisory and does not block the merge.>

---
*TLM QA Agent — advisory mode | [View run](<run-url>)*
```

---

## Edge Cases and Special Handling

- **Auth-gated pages:** If navigating to a route redirects to a sign-in page, mark the criterion as SKIP with reason `AUTH_REQUIRED` unless credentials are provided
- **Preview not yet ready:** If the URL returns 503 or a "deployment in progress" page, wait up to 60 seconds with 10-second retries before declaring `DEPLOYMENT_UNREACHABLE`
- **Flaky selectors:** If a locator fails, try once with a 5-second explicit wait before marking FAIL
- **Empty PR body:** If no acceptance criteria can be extracted, Pass 2 reports "No testable acceptance criteria found" and skips all checks
- **Multiple preview URLs:** Use only `PREVIEW_URL` from the environment — do not attempt to discover alternate URLs
```

### Step 3: Create the playwright.config.ts

Create `.github/actions/tlm-qa-agent/playwright.config.ts`:

```typescript
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the TLM QA Agent.
 * 
 * - baseURL is sourced from PREVIEW_URL environment variable (set by action.yml)
 * - Single Chromium project — no cross-browser testing needed for advisory QA
 * - 30s per-test timeout, 10s per-action timeout
 * - No retries — flakiness is reported, not masked
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 0,
  workers: 1,

  reporter: [
    ['list'],
    ['json', { outputFile: 'qa-results.json' }],
  ],

  use: {
    baseURL: process.env.PREVIEW_URL,
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
```

### Step 4: Verification

Verify the files are syntactically valid:

```bash
# Validate YAML
npx js-yaml .github/actions/tlm-qa-agent/action.yml && echo "action.yml: valid YAML"

# Validate TypeScript config
npx tsc --noEmit .github/actions/tlm-qa-agent/playwright.config.ts 2>/dev/null || \
  node -e "
    const fs = require('fs');
    const content = fs.readFileSync('.github/actions/tlm-qa-agent/playwright.config.ts', 'utf-8');
    // Basic structural check
    if (content.includes('defineConfig') && content.includes('baseURL') && content.includes('timeout: 30000')) {
      console.log('playwright.config.ts: structurally valid');
    } else {
      console.error('playwright.config.ts: missing required fields');
      process.exit(1);
    }
  "

# Confirm all three files exist
ls -la .github/actions/tlm-qa-agent/

# Verify action.yml has all required inputs
grep -E "preview-url|pr-number|repo|anthropic-api-key|qa-bypass-secret|github-token" \
  .github/actions/tlm-qa-agent/action.yml | wc -l

# Verify system-prompt.md has the three passes
grep -E "Pass 1|Pass 2|Pass 3|smoke|acceptance criteria|regression" \
  .github/actions/tlm-qa-agent/system-prompt.md

# Verify playwright.config.ts has required settings
grep -E "PREVIEW_URL|30000|10000|chromium|retries: 0" \
  .github/actions/tlm-qa-agent/playwright.config.ts
```

Expected output: all three files exist, action.yml has 6 input matches, system-prompt.md shows three passes, playwright.config.ts shows all required settings.

### Step 5: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add TLM QA Agent scaffold (action.yml, system-prompt, playwright config)"
git push origin feat/tlm-qa-agent-scaffold
gh pr create \
  --title "feat: QA Agent GitHub Action scaffold and system prompt" \
  --body "## Summary

Adds the foundational scaffold for the TLM QA Agent GitHub Action:

- \`.github/actions/tlm-qa-agent/action.yml\` — Composite action with inputs for preview-url, pr-number, repo, anthropic-api-key, qa-bypass-secret, github-token. Includes Playwright browser cache restore via \`actions/cache\` keyed on Playwright version.
- \`.github/actions/tlm-qa-agent/system-prompt.md\` — Full QA Agent instructions covering three-pass verification strategy (smoke test, acceptance criteria, regression placeholder), output format template, classification guidance (HTTP-verifiable / Playwright-verifiable / not-verifiable), timeout rules, and advisory-mode behavior.
- \`.github/actions/tlm-qa-agent/playwright.config.ts\` — Single Chromium project, baseURL from PREVIEW_URL env var, 30s test timeout, 10s action timeout, no retries.

The entrypoint script (\`run-qa.ts\`) is referenced by action.yml but will be implemented in a follow-up work item.

## Acceptance Criteria
- [x] action.yml exists with all 6 required inputs
- [x] action.yml includes Playwright cache restore step keyed on version
- [x] system-prompt.md contains all three passes and output format template
- [x] playwright.config.ts configures Chromium with 30000ms timeout and PREVIEW_URL baseURL
- [x] No existing files modified — pure addition

## Risk
Low — adds new files only, no existing functionality touched."
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/tlm-qa-agent-scaffold
FILES CHANGED: [list which of the 3 files were created]
SUMMARY: [what was done]
ISSUES: [what failed — e.g., YAML validation error, file not created]
NEXT STEPS: [which files still need to be created]
```