# Handoff: Bump Global Concurrency Limit from 3 to 5

Max Budget: $2 | Model: opus | Risk: low

## Context

The ATC's `GLOBAL_CONCURRENCY_LIMIT` is hardcoded to 3 in `lib/atc.ts`. With multi-repo support (agent-forge + personal-assistant) and the DAG parallel dispatch improvement incoming, 3 concurrent executions is the bottleneck. Independent items across different repos and non-conflicting items within the same repo should be able to run concurrently up to a higher limit. Per-repo concurrency limits (set in the repo registry) provide the fine-grained control, so the global limit just needs headroom.

This is a one-line change plus an update to the ATC dashboard to display the new limit.

## Pre-flight Self-check

- [ ] Read `lib/atc.ts` and find `GLOBAL_CONCURRENCY_LIMIT` (should be near the top, around line 10-15)
- [ ] Grep for any other references to `GLOBAL_CONCURRENCY_LIMIT` or the number 3 used as a concurrency check
- [ ] Check if the dashboard displays this value anywhere (search `app/` for "concurrency")
- [ ] Run `npm run build` to confirm current state compiles

## Step 0: Branch + Commit Setup

Branch: `fix/bump-concurrency-limit` (already created)
Base: `main`

## Step 1: Update the Constant

In `lib/atc.ts`, change:
```typescript
const GLOBAL_CONCURRENCY_LIMIT = 3;
```
To:
```typescript
const GLOBAL_CONCURRENCY_LIMIT = 5;
```

## Step 2: Update Dashboard Display (if applicable)

Search `app/` directory for any hardcoded "3" that references the global concurrency limit (e.g., in status displays, tooltips, or ATC dashboard components). If found, update to match the new value of 5. If the dashboard reads the value dynamically from the ATC state, no change is needed.

Also check `components/` for any ATC-related components that might display concurrency info.

## Step 3: Verification

- `npm run build` must pass
- `npx tsc --noEmit` must pass
- Grep for `GLOBAL_CONCURRENCY_LIMIT` to confirm exactly one definition with value 5
- Grep for any remaining hardcoded `= 3` near concurrency-related code to ensure nothing was missed

## Abort Protocol

This is a trivial change. If build fails, it is unrelated to this change. Investigate and fix the pre-existing build issue, then retry.
