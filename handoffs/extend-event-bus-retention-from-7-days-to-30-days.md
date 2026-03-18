<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Extend Event Bus Retention from 7 Days to 30 Days

## Metadata
- **Branch:** `feat/extend-event-bus-retention-30-days`
- **Priority:** medium
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/event-bus.ts

## Context

The event bus (`lib/event-bus.ts`) stores durable webhook events in Vercel Blob using hourly partitions at `af-data/events/YYYY-MM-DD-HH`. A `RETENTION_DAYS` constant controls how far back `cleanupOldPartitions()` keeps data before deleting it.

The current value is 7 days. The Feedback Compiler agent runs on a weekly cron (Sunday 10pm UTC). If a single run is missed or fails, the next run will find that the earliest data has already been purged — losing a full week of event history before the compiler gets another chance to analyze it. Extending retention to 30 days gives 4 weekly cycles of buffer, enabling proper trend analysis across multiple feedback iterations.

The Blob cost impact is negligible: events are small JSON payloads and hourly partitions are compact.

This is a targeted one-line constant change. The task also requires verifying:
1. `cleanupOldPartitions()` references `RETENTION_DAYS` (not a hardcoded literal)
2. No other files in the codebase hardcode or assume 7-day retention

**No conflict with concurrent work:** The concurrent branch `fix/add-structured-agent-trace-logging-to-all-autonomo` touches `lib/atc/tracing.ts`, `lib/atc/dispatcher.ts`, `lib/atc/health-monitor.ts`, `lib/atc/project-manager.ts`, `lib/atc/supervisor.ts`, and `app/api/agents/traces/route.ts` — none of which overlap with `lib/event-bus.ts`.

## Requirements

1. Change `RETENTION_DAYS` constant in `lib/event-bus.ts` from `7` to `30`
2. Confirm `cleanupOldPartitions()` uses `RETENTION_DAYS` (not a hardcoded number) — if it hardcodes `7`, fix it to use the constant
3. Search the entire codebase for any other hardcoded references to the 7-day event retention assumption (e.g., comments, other constants, API route docs) and update them to reflect 30 days
4. TypeScript must compile without errors (`npx tsc --noEmit`)
5. Any existing tests for `event-bus.ts` must continue to pass

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/extend-event-bus-retention-30-days
```

### Step 1: Inspect lib/event-bus.ts

Read the full file to understand the current structure before making any changes:

```bash
cat lib/event-bus.ts
```

Confirm:
- The `RETENTION_DAYS` constant exists and is currently set to `7`
- `cleanupOldPartitions()` references `RETENTION_DAYS` (not a literal `7`)

If `cleanupOldPartitions()` uses a hardcoded `7` instead of the constant, that must also be fixed in this step.

### Step 2: Change RETENTION_DAYS to 30

Edit `lib/event-bus.ts`. Find the line:
```typescript
const RETENTION_DAYS = 7;
```
Change it to:
```typescript
const RETENTION_DAYS = 30;
```

If there is a comment on the same line or nearby referencing "7 days", update it to "30 days" for accuracy. Example:
```typescript
// Keep 30 days of hourly event partitions for Feedback Compiler trend analysis
const RETENTION_DAYS = 30;
```

### Step 3: Audit codebase for hardcoded 7-day retention assumptions

Search for any other references to the old 7-day value or related assumptions:

```bash
# Search for hardcoded 7-day references in event-related context
grep -rn "7.day\|7 day\|RETENTION_DAYS\|retention.*7\|7.*retention" \
  --include="*.ts" --include="*.tsx" --include="*.md" \
  . | grep -v node_modules | grep -v ".next" | grep -v "dist"

# Search for the literal number in event-bus context
grep -rn "event-bus\|eventBus\|event_bus" \
  --include="*.ts" --include="*.tsx" \
  . | grep -v node_modules | grep -v ".next"
```

For any hits that hardcode the old 7-day assumption in comments or documentation, update them to reflect 30 days. Do **not** modify files that are part of the concurrent branch's scope (`lib/atc/tracing.ts`, `lib/atc/dispatcher.ts`, `lib/atc/health-monitor.ts`, `lib/atc/project-manager.ts`, `lib/atc/supervisor.ts`, `app/api/agents/traces/route.ts`).

### Step 4: Check system documentation

The system map and CLAUDE.md both reference the event bus retention period:

```bash
grep -n "7-day\|7 day\|retention" docs/SYSTEM_MAP.md CLAUDE.md 2>/dev/null
```

If either file mentions "7-day retention" in the context of the event bus, update the relevant line to say "30-day retention". Example — in `CLAUDE.md` or `docs/SYSTEM_MAP.md`:

Before:
```
Durable log: Vercel Blob (hourly, 7-day retention)
```
After:
```
Durable log: Vercel Blob (hourly, 30-day retention)
```

### Step 5: Run TypeScript type check

```bash
npx tsc --noEmit
```

Resolve any type errors before proceeding. There should be none for this change.

### Step 6: Run existing tests

```bash
# Run any tests related to event-bus
npm test -- --testPathPattern="event-bus" 2>/dev/null || true

# Run full test suite
npm test 2>/dev/null || echo "No test runner configured or no tests found"
```

If tests exist and fail, investigate. A pure constant value change should not break any tests unless a test explicitly asserts `RETENTION_DAYS === 7` — in which case update the test expectation to `30`.

### Step 7: Verification

```bash
# Confirm the change is in place
grep -n "RETENTION_DAYS" lib/event-bus.ts

# Confirm cleanupOldPartitions uses the constant (not a literal)
grep -n "cleanupOldPartitions\|RETENTION_DAYS\|7\b" lib/event-bus.ts

# Confirm no remaining hardcoded 7-day event retention references
grep -rn "7.day\|7 day" --include="*.ts" --include="*.tsx" . \
  | grep -v node_modules | grep -v ".next" | grep -i "event\|retention" || echo "No hardcoded references found"

# TypeScript clean
npx tsc --noEmit && echo "TypeScript OK"
```

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "fix: extend event bus retention from 7 to 30 days

Feedback Compiler runs weekly — 7-day retention means a single missed
run loses data before the next cycle can analyze it. 30 days gives 4
weekly cycles of history for trend analysis.

Blob cost impact is negligible (small JSON, hourly partitions).
Also updated retention references in CLAUDE.md and SYSTEM_MAP.md."

git push origin feat/extend-event-bus-retention-30-days

gh pr create \
  --title "fix: extend event bus retention from 7 to 30 days" \
  --body "## Summary

Changes \`RETENTION_DAYS\` in \`lib/event-bus.ts\` from \`7\` to \`30\`.

## Motivation

The Feedback Compiler runs on a weekly cron (Sunday 10pm UTC). With 7-day retention, a single missed or failed run means the next cycle has no event history to analyze — the data was already purged. 30-day retention provides 4 weekly cycles of buffer for trend analysis.

Blob cost impact is negligible: events are small JSON payloads stored in hourly partitions.

## Changes

- \`lib/event-bus.ts\`: \`RETENTION_DAYS\` 7 → 30
- \`CLAUDE.md\` / \`docs/SYSTEM_MAP.md\`: Updated retention references from 7-day to 30-day (if present)

## Verification

- \`cleanupOldPartitions()\` confirmed to use \`RETENTION_DAYS\` constant (not hardcoded literal)
- No other files hardcode 7-day event retention assumption
- \`npx tsc --noEmit\` passes
- All existing tests pass

## Risk

Low — single constant change. No logic modified. Cleanup runs less aggressively, which is the desired behavior." \
  --base main
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/extend-event-bus-retention-30-days
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed or was unclear]
NEXT STEPS: [what remains]
```

If `cleanupOldPartitions()` does NOT reference `RETENTION_DAYS` and instead uses a hardcoded value in a way that is architecturally complex to untangle (e.g., it's computed differently), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "extend-event-bus-retention-30-days",
    "reason": "cleanupOldPartitions() does not use RETENTION_DAYS constant — retention logic is more complex than a single constant change",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "Step 1",
      "error": "Retention not controlled by RETENTION_DAYS constant alone",
      "filesChanged": []
    }
  }'
```