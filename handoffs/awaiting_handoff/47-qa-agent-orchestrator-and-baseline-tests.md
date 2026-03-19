# Handoff 47: qa-agent-orchestrator-and-baseline-tests

## Metadata
- Branch: `feat/qa-agent-orchestrator-and-baseline-tests`
- Priority: high
- Model: opus
- Type: feature
- Max Budget: $5
- Risk Level: low
- Complexity: moderate
- Depends On: None
- Date: 2026-03-19
- Executor: Claude Code (GitHub Actions)

## Context

The pipeline has NO pre-merge functional testing. Branch protection checks CI build/tests but not runtime behavior. This session we shipped 20+ PRs and broke the dashboard twice (heartbeat showing 0/0, trace viewer blank) — both passed CI. A working QA Agent would have caught both.

An old QA Agent exists but was disabled as a no-op stub. ~70% of infrastructure is built: workflow trigger (deployment_status), composite action with Playwright config, smoke test utility, criteria parser, comment formatter, action ledger. The core orchestrator (run-qa.ts) is a stub that needs full implementation, and the Playwright test suite needs to be written.

Architecture: Per-repo QA Agent with tiered execution. Bail-early: Tier 0 smoke (<5s) → Tier 1 Playwright baseline (<30s) → Tier 2 API health (<30s) → Tier 3 acceptance criteria (<60s). Tests verify the new 4-agent architecture: agent cards on /agents page, /api/agents/traces endpoint, /api/events endpoint.

Auth: QA bypass middleware is already deployed. Send X-QA-Agent-Token header → middleware injects session cookie → dashboard pages render. Playwright global setup navigates to / with the header, saves storage state, all tests reuse it.

IMPORTANT: Reuse existing code — do NOT rewrite smoke-test.ts, parse-criteria.ts, format-comment.ts, or action-ledger.ts. Only build: run-qa.ts orchestrator, tests/auth-setup.ts, tests/baseline.spec.ts, tests/api-health.spec.ts, and update playwright.config.ts.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] Verify existing files are NOT modified: src/smoke-test.ts, src/parse-criteria.ts, src/format-comment.ts, src/action-ledger.ts
- [ ] Verify run-qa.ts imports and calls existing utilities (not reimplementing them)
- [ ] Verify playwright.config.ts has globalSetup, storageState, and extraHTTPHeaders
- [ ] Verify auth-setup.ts saves state to .auth/state.json
- [ ] Verify all tests use page.on('pageerror') for console error detection
- [ ] Verify API health tests accept 401 but fail on 5xx
- [ ] Run npx playwright test --list to confirm all test files are discovered

## Step 0: Branch, commit handoff, push

Create branch `feat/qa-agent-orchestrator-and-baseline-tests` from `main`. Commit this handoff file. Push.

## Step 1: Replace `.github/actions/tlm-qa-agent/run-qa.ts` stub with full orchestrator: (1) Run smoke tests via existing smoke-test.ts against routes /, /agents, /work-items, /pipeline, /settings. (2) Run Playwright tests via execSync('npx playwright test --reporter=json'). (3) Parse qa-results.json. (4) Fetch PR description via Octokit, extract acceptance criteria via existing parse-criteria.ts. (5) For http criteria: fetch route, check status. For playwright criteria: match against known routes. (6) Format and post PR comment via existing format-comment.ts. Update existing comment on re-run (search for '## 🤖 QA Agent Report'). (7) Log structured results to stdout (skip action-ledger git push for Tier 1). (8) Exit 0 always (advisory mode).

## Step 2: Create `.github/actions/tlm-qa-agent/tests/auth-setup.ts` — Playwright global setup: create browser context with extraHTTPHeaders { 'X-QA-Agent-Token': process.env.QA_BYPASS_SECRET }, navigate to preview URL root to trigger cookie injection, save storage state to .auth/state.json, close browser.

## Step 3: Create `.github/actions/tlm-qa-agent/tests/baseline.spec.ts` — Tier 1 Playwright regression suite: (1) Dashboard loads — navigate to /, assert page has heading or stats content. (2) Agents page loads — navigate to /agents, assert agent cards visible (look for 'Dispatcher', 'Health Monitor', 'Project Manager', 'Supervisor'). (3) Agents page shows trace viewer section. (4) Work Items page loads — navigate to /work-items, assert table or filter UI renders. (5) Pipeline page loads — navigate to /pipeline, assert no error state. (6) No console errors on any page — use page.on('pageerror') to capture uncaught exceptions, fail test if any thrown.

## Step 4: Create `.github/actions/tlm-qa-agent/tests/api-health.spec.ts` — Tier 2 API infrastructure health: (1) /api/agents/traces returns non-5xx with JSON containing 'traces' array. (2) /api/events returns non-5xx with JSON. (3) /api/work-items returns non-5xx with valid JSON. (4) /api/agents/atc-metrics returns non-5xx with metrics object. Use page.request.get() for API calls. Accept 401 (auth required) but fail on 5xx.

## Step 5: Update `.github/actions/tlm-qa-agent/playwright.config.ts`: add globalSetup: './tests/auth-setup.ts', add storageState: '.auth/state.json' to use block, add extraHTTPHeaders: { 'X-QA-Agent-Token': process.env.QA_BYPASS_SECRET || '' } to use block. Keep baseURL from PREVIEW_URL env var. Keep 30s timeout. Keep Chromium only. Keep JSON reporter to qa-results.json.

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: qa-agent-orchestrator-and-baseline-tests (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "feat/qa-agent-orchestrator-and-baseline-tests",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```