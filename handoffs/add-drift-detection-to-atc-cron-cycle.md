# Agent Forge -- Add drift detection to ATC cron cycle

## Metadata
- **Branch:** `feat/atc-drift-detection-cycle`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/atc.ts

## Context

Agent Forge has a periodic ATC (Air Traffic Controller) cron cycle in `lib/atc.ts` that orchestrates work item dispatch, conflict detection, stall recovery, and other health checks. A drift detection module exists (or will exist) at `lib/drift-detection.ts` that exposes:

- `detectDrift(workItems, baselineDays, currentDays)` — compares recent throughput/quality against a baseline window
- `saveDriftSnapshot(snapshot)` — persists results to Vercel Blob under `af-data/drift/`
- `formatDriftAlert(snapshot)` — formats a human-readable alert string
- The snapshot result includes a `degraded: boolean` field

The ATC cycle state is persisted in a Vercel Blob (path `af-data/atc/*`). The state object already carries timestamps for various subsystems (e.g., last run times). This task adds a new §14 — Drift Detection section to the ATC cycle that runs at most once per 24 hours.

**No files overlap with concurrent work** (`fix/bootstrap-rez-sniper-push-execute-handoffyml-via-g` only touches `handoffs/` and an ephemeral shell script).

## Requirements

1. `lib/atc.ts` imports `detectDrift`, `saveDriftSnapshot`, and `formatDriftAlert` from `lib/drift-detection.ts`
2. The ATC state blob type includes a `lastDriftCheckAt?: string` (ISO timestamp) field
3. A new §14 — Drift Detection section runs inside the ATC cycle, gated by a 24h check against `lastDriftCheckAt`
4. The section loads all work items and calls `detectDrift()` with a 30-day baseline window and 7-day current window
5. The result is persisted via `saveDriftSnapshot()`
6. If the snapshot's `degraded` field is `true`, an alert is sent via `lib/gmail.ts` (using `formatDriftAlert()`) or, if email sending fails, logs a structured warning to the cycle output
7. The ATC state blob is updated with `lastDriftCheckAt` set to the current ISO timestamp after the check
8. `npm run build` succeeds with no TypeScript errors

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/atc-drift-detection-cycle
```

### Step 1: Inspect existing files

Before making changes, read the relevant files to understand current structure:

```bash
# Understand ATC state type and cycle structure
cat lib/atc.ts

# Understand what drift-detection exports (may not exist yet — see Step 2)
cat lib/drift-detection.ts 2>/dev/null || echo "FILE NOT FOUND"

# Understand gmail sendAlert / sendEmail signature
cat lib/gmail.ts

# Understand work items loader
cat lib/work-items.ts | head -80
```

Note the exact shape of the ATC state object (look for something like `AtcState`, `AirTrafficState`, or similar interface). Note how existing sections (§1–§13) are structured — they typically check a condition, perform work, log events, and update state.

### Step 2: Handle drift-detection module existence

The drift-detection module at `lib/drift-detection.ts` may or may not exist yet. Check:

```bash
ls lib/drift-detection.ts 2>/dev/null && echo "EXISTS" || echo "MISSING"
```

**If it exists:** proceed to Step 3.

**If it does NOT exist:** create a minimal stub so `lib/atc.ts` can compile. The stub must match the interface described in the work item:

```typescript
// lib/drift-detection.ts (stub — replace with real implementation when available)

import { WorkItem } from './types';
import { put } from '@vercel/blob';

export interface DriftSnapshot {
  timestamp: string;
  baselineDays: number;
  currentDays: number;
  degraded: boolean;
  metrics: Record<string, { baseline: number; current: number; delta: number }>;
  summary: string;
}

/**
 * Compares work item throughput/quality in the current window against a baseline.
 */
export async function detectDrift(
  workItems: WorkItem[],
  baselineDays: number,
  currentDays: number
): Promise<DriftSnapshot> {
  const now = Date.now();
  const currentCutoff = now - currentDays * 24 * 60 * 60 * 1000;
  const baselineCutoff = now - baselineDays * 24 * 60 * 60 * 1000;

  const currentItems = workItems.filter(
    (wi) => wi.updatedAt && new Date(wi.updatedAt).getTime() > currentCutoff
  );
  const baselineItems = workItems.filter(
    (wi) =>
      wi.updatedAt &&
      new Date(wi.updatedAt).getTime() > baselineCutoff &&
      new Date(wi.updatedAt).getTime() <= currentCutoff
  );

  const currentMerged = currentItems.filter((wi) => wi.status === 'merged').length;
  const baselineMerged = baselineItems.filter((wi) => wi.status === 'merged').length;

  // Normalise to per-day rates
  const currentRate = currentDays > 0 ? currentMerged / currentDays : 0;
  const baselineRate =
    baselineDays - currentDays > 0 ? baselineMerged / (baselineDays - currentDays) : 0;

  const delta = baselineRate > 0 ? (currentRate - baselineRate) / baselineRate : 0;
  const degraded = baselineRate > 0 && delta < -0.3; // >30% drop = degraded

  return {
    timestamp: new Date().toISOString(),
    baselineDays,
    currentDays,
    degraded,
    metrics: {
      mergeRate: { baseline: baselineRate, current: currentRate, delta },
    },
    summary: degraded
      ? `Merge rate dropped ${Math.round(Math.abs(delta) * 100)}% vs baseline`
      : 'No significant drift detected',
  };
}

/**
 * Persists a drift snapshot to Vercel Blob.
 */
export async function saveDriftSnapshot(snapshot: DriftSnapshot): Promise<void> {
  const key = `af-data/drift/${snapshot.timestamp.replace(/[:.]/g, '-')}.json`;
  await put(key, JSON.stringify(snapshot, null, 2), {
    access: 'public',
    addRandomSuffix: false,
  });
}

/**
 * Formats a drift snapshot as a human-readable alert string.
 */
export function formatDriftAlert(snapshot: DriftSnapshot): string {
  return [
    `🚨 Agent Forge Drift Alert`,
    `Timestamp: ${snapshot.timestamp}`,
    `Status: DEGRADED`,
    `Summary: ${snapshot.summary}`,
    ``,
    `Metrics:`,
    ...Object.entries(snapshot.metrics).map(
      ([k, v]) =>
        `  ${k}: baseline=${v.baseline.toFixed(3)}, current=${v.current.toFixed(3)}, delta=${(v.delta * 100).toFixed(1)}%`
    ),
    ``,
    `Review the pipeline at your Agent Forge dashboard.`,
  ].join('\n');
}
```

### Step 3: Update lib/atc.ts

Open `lib/atc.ts` and make the following changes:

#### 3a. Add import

Near the top of `lib/atc.ts`, alongside other `lib/` imports, add:

```typescript
import { detectDrift, saveDriftSnapshot, formatDriftAlert } from './drift-detection';
```

#### 3b. Update the ATC state type

Find the ATC state interface/type (look for `AtcState`, `AirTrafficState`, or similar). Add the optional field:

```typescript
lastDriftCheckAt?: string; // ISO timestamp of last drift detection run
```

If the state is defined as a plain object literal without a named interface, add the field to wherever state is initialised/read (the default state object).

#### 3c. Add §14 — Drift Detection section

Find the final numbered section in the ATC cycle (currently §13 or similar). After it completes, add the new section. Follow the exact same structural pattern as existing sections — typically a comment header, a condition check, the work, event emission, and a state update.

Here is the section to add (adapt variable names to match the existing codebase style):

```typescript
// §14 — Drift Detection (once per 24h)
const DRIFT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const lastDriftCheck = state.lastDriftCheckAt
  ? new Date(state.lastDriftCheckAt).getTime()
  : 0;
const driftCheckDue = Date.now() - lastDriftCheck > DRIFT_CHECK_INTERVAL_MS;

if (driftCheckDue) {
  try {
    log('§14 — Drift Detection: running drift check');
    const allWorkItems = await listWorkItems(); // use the same loader already in scope
    const driftSnapshot = await detectDrift(allWorkItems, 30, 7);
    await saveDriftSnapshot(driftSnapshot);
    state.lastDriftCheckAt = new Date().toISOString();

    if (driftSnapshot.degraded) {
      const alertBody = formatDriftAlert(driftSnapshot);
      log(`§14 — Drift Detection: DEGRADED — ${driftSnapshot.summary}`);
      try {
        await sendAlertEmail({
          subject: '🚨 Agent Forge: Pipeline Drift Detected',
          body: alertBody,
        });
        log('§14 — Drift Detection: alert email sent');
      } catch (emailErr) {
        // Non-fatal — log warning but don't fail the cycle
        console.warn('[ATC §14] Failed to send drift alert email:', emailErr);
        log(`§14 — Drift Detection: WARNING — email send failed: ${String(emailErr)}`);
      }
    } else {
      log(`§14 — Drift Detection: OK — ${driftSnapshot.summary}`);
    }
  } catch (driftErr) {
    // Non-fatal — drift detection failure should not disrupt the ATC cycle
    console.warn('[ATC §14] Drift detection failed:', driftErr);
    log(`§14 — Drift Detection: ERROR — ${String(driftErr)}`);
  }
} else {
  log('§14 — Drift Detection: skipped (last check within 24h)');
}
```

**Important implementation notes:**
- Replace `listWorkItems()` with whatever function is already used in `lib/atc.ts` to load work items (e.g., `getAllWorkItems()`, `loadWorkItems()`, etc.)
- Replace `sendAlertEmail(...)` with whatever Gmail sending function is available in `lib/gmail.ts` (e.g., `sendEmail()`, `sendGmailAlert()`, etc.) — check the actual export names in Step 1
- Replace `log(...)` with the actual logging utility already used in the cycle (e.g., `addEvent()`, `emit()`, `logger.info()`, etc.)
- Keep the state write (updating `lastDriftCheckAt`) inside the `try` block so it only persists on success
- The entire section must be non-fatal: wrap in try/catch and continue the cycle on any error

#### 3d. Ensure state is saved

Confirm that the existing code path that saves ATC state back to Vercel Blob will pick up `lastDriftCheckAt`. Since state is a mutable object that is written back at the end of the cycle, this should be automatic — but verify the state-save call includes the full state object.

### Step 4: Check for email sending function signature

Inspect `lib/gmail.ts` to confirm the correct function name and signature for sending alert emails:

```bash
grep -n "export.*function\|export.*async\|export.*const" lib/gmail.ts
```

Adapt the `sendAlertEmail` call in §14 to match the actual exported function. Common patterns in this codebase:
- `sendEmail({ to, subject, body })` 
- `sendAlertEmail(subject, body)`
- `sendEscalationEmail(subject, html)`

Use whatever signature exists. If no general-purpose email sender exists, fall back to just logging the warning (the try/catch already handles this gracefully).

### Step 5: Verification

```bash
# TypeScript type check
npx tsc --noEmit

# Full build
npm run build

# Confirm no lint errors (if lint script exists)
npm run lint 2>/dev/null || true

# Confirm the new section is present
grep -n "Drift Detection\|lastDriftCheckAt\|detectDrift\|saveDriftSnapshot\|formatDriftAlert" lib/atc.ts
```

Expected output from the grep: at least 5 lines covering the import, the state field reference, and the §14 section calls.

If `npx tsc --noEmit` reports errors related to `lib/drift-detection.ts` exports not matching what `lib/atc.ts` imports, adjust the stub in Step 2 to match.

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add drift detection to ATC cron cycle (§14)"
git push origin feat/atc-drift-detection-cycle
gh pr create \
  --title "feat: add drift detection to ATC cron cycle (§14)" \
  --body "## Summary

Integrates drift detection into the ATC periodic monitoring cycle.

## Changes

- **\`lib/atc.ts\`**: Added import of \`detectDrift\`, \`saveDriftSnapshot\`, \`formatDriftAlert\` from \`lib/drift-detection\`. Added \`lastDriftCheckAt\` field to ATC state type. Added §14 — Drift Detection section that runs once per 24h.
- **\`lib/drift-detection.ts\`** (if created): Minimal implementation stub with \`DriftSnapshot\` type, \`detectDrift\`, \`saveDriftSnapshot\`, and \`formatDriftAlert\` exports.

## Behaviour

- Drift check runs at most once per 24h (gated by \`lastDriftCheckAt\` in ATC state blob)
- Loads all work items, calls \`detectDrift(workItems, 30, 7)\` (30-day baseline, 7-day current)
- Persists snapshot to \`af-data/drift/\` via \`saveDriftSnapshot\`
- If \`degraded: true\`, attempts to send alert email; falls back to logged warning on email failure
- Entire section is wrapped in try/catch — drift detection failure does not disrupt the ATC cycle
- ATC state updated with \`lastDriftCheckAt\` timestamp on success

## Acceptance Criteria
- [x] \`lib/atc.ts\` imports drift detection functions
- [x] New §14 section performs drift detection with 24h rate limit
- [x] Drift snapshots saved to \`af-data/drift/\` blob path
- [x] Degraded drift triggers alert (email or logged warning)
- [x] \`npm run build\` succeeds
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/atc-drift-detection-cycle
FILES CHANGED: [lib/atc.ts, lib/drift-detection.ts (if created)]
SUMMARY: [what was done]
ISSUES: [what failed — e.g., "drift-detection.ts does not exist and stub has type mismatch with atc.ts usage"]
NEXT STEPS: [e.g., "Implement real lib/drift-detection.ts with correct DriftSnapshot shape"]
```

## Escalation Protocol

If you encounter an unresolvable blocker (e.g., `lib/drift-detection.ts` exports a completely different API than described, or the ATC state blob has no clear update path):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-drift-detection-to-atc-cron-cycle",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc.ts", "lib/drift-detection.ts"]
    }
  }'
```