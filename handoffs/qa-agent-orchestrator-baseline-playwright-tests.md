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

**Concurrent work awareness:** A concurrent branch (`fix/show-github-actions-tlm-agents-in-dashboard-agent-`) is touching `app/(app)/agents/page.tsx`, `app/api/agents/tlm-agents/route.ts`, `components/tlm-agent-heartbeat.tsx`, and `lib/hooks.ts`. All files in this handoff live under `.github/actions/tlm-qa-agent/` — zero overlap. No coordination needed.

## Requirements

1. `run-qa.ts` orchestrates the full QA cycle: smoke tests → Playwright suite → result parsing → PR comment post.
2. `run-qa.ts` always exits with code 0 (advisory mode).
3. `tests/auth-setup.ts` creates a browser context with `X-QA-Agent-Token` header, navigates to `/`, and saves storage state to `.auth/state.json`.
4. `tests/baseline.spec.ts` (Tier 1) tests: dashboard heading/stats visible, agents page loads with agent cards, agents page shows trace viewer section, work items page loads with table/filters, pipeline page loads, no console errors on any page.
5. `tests/api-health.spec.ts` (Tier 2) tests: `/api/agents/traces`, `/api/events`, `/api/agents/heartbeats`, `/api/work-items`, `/api/agents/atc-metrics` all return non-5xx and return expected shapes.
6. `playwright.config.ts` sets `globalSetup` to `auth-setup.ts`, configures `storageState`, and sets `extraHTTPHeaders` with the QA bypass token.
7. Playwright results are written to `qa-results.json` (via the JSON reporter configured in `playwright.config.ts`) and parsed by the orchestrator.
8. All new files live exclusively under `.github/actions/tlm-qa-agent/`.
9. Existing files (`smoke-test.ts`, `parse-criteria.ts`, `format-comment.ts`) are reused without modification unless a minor import/type fix is strictly required.

## Execution Steps

### Step 0: Branch setup