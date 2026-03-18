<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Move Drift Detection from ATC to Supervisor Agent

## Metadata
- **Branch:** `feat/supervisor-drift-detection`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/atc/supervisor.ts, lib/drift.ts (read-only reference)

## Context

PR #288 added drift detection as §17 in the legacy ATC monolith (`lib/atc.ts`). It was closed because drift detection belongs in the Supervisor agent (`lib/atc/supervisor.ts`), which already runs every 10 minutes and monitors system health — not in the deprecated ATC monolith.

The Supervisor agent is one of four autonomous agents introduced in ADR-010, replacing the ATC monolith. It lives at `lib/atc/supervisor.ts` and is invoked via `app/api/agents/supervisor/cron/route.ts`. The Supervisor handles agent health monitoring, escalation management, and maintenance tasks.

Drift detection should be added as a new phase in the Supervisor's cycle. It must:
- Run at most once per 24h, gated by a `lastDriftCheckAt` timestamp in the Supervisor's own agent state (not ATC state)
- Load all work items and compute Jensen-Shannon divergence (30-day baseline vs 7-day current window)
- Persist snapshots to `af-data/drift/` using the existing `saveDriftSnapshot` function (in `lib/drift.ts` or similar)
- Send an email alert on detected degradation, falling back to a logged warning if email fails
- Be entirely non-fatal (wrapped in try/catch)

**Do NOT modify `lib/atc.ts`.** It is being deprecated.

**Concurrent work to avoid:** `fix/dashboard-qa-results-section-api-route` touches `app/api/qa-results/route.ts` — no overlap with this task.

## Requirements

1. Add a `lastDriftCheckAt` field to the Supervisor agent's state type (wherever that is defined — likely `lib/atc/types.ts` or inline in `supervisor.ts`).
2. In `lib/atc/supervisor.ts`, add a new phase (e.g., §5 or next available number) that runs drift detection at most once per 24h.
3. The drift phase must load all work items from storage.
4. Compute Jensen-Shannon divergence between a 30-day baseline window and the 7-day current window using the existing drift logic (mirror the approach from PR #288 or `lib/drift.ts`).
5. Call `saveDriftSnapshot` (or equivalent existing function) to persist the result to `af-data/drift/`.
6. If degradation is detected, send an email alert via the existing Gmail/email utility (`lib/gmail.ts`). If email sending fails, log a warning and continue — do not throw.
7. The entire drift detection phase must be wrapped in `try/catch` and be non-fatal to the Supervisor's cycle.
8. Do not modify `lib/atc.ts` under any circumstances.
9. TypeScript must compile cleanly (`npx tsc --noEmit`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/supervisor-drift-detection
```

### Step 1: Explore existing code to understand current structure

Read the following files to understand what already exists before writing any code:

```bash
# Understand the Supervisor agent structure
cat lib/atc/supervisor.ts

# Understand shared types (SupervisorState, AgentState, etc.)
cat lib/atc/types.ts

# Find drift utilities — check both possible locations
ls lib/drift* 2>/dev/null || echo "no lib/drift*"
cat lib/drift.ts 2>/dev/null || echo "no lib/drift.ts"
find lib -name "*.ts" | xargs grep -l "saveDriftSnapshot\|DriftSnapshot\|jensenShannon\|jsDivergence" 2>/dev/null

# Understand email utility
cat lib/gmail.ts | head -80

# Find what PR #288 implemented (grep for drift in atc.ts to understand the logic)
grep -n "drift\|Drift\|jensen\|divergence" lib/atc.ts | head -60

# Check storage patterns
grep -n "saveDriftSnapshot\|af-data/drift" lib/ -r

# Understand how Supervisor loads/saves its state
grep -n "supervisorState\|SupervisorState\|lastDrift\|agentState" lib/atc/supervisor.ts | head -40
```

### Step 2: Understand the drift computation logic from PR #288

Before implementing, extract the drift logic pattern from `lib/atc.ts` (§17) or `lib/drift.ts`:

```bash
# Find the drift section in atc.ts (for reference only — do NOT modify atc.ts)
grep -n "§17\|drift\|Drift\|jensen\|Shannon\|divergence\|baseline\|30.day\|7.day" lib/atc.ts

# Check if there's already a standalone drift module
find . -name "drift.ts" -not -path "*/node_modules/*"
find . -name "drift*.ts" -not -path "*/node_modules/*"
```

The drift computation should:
- Group work items by day using `mergedAt` or `updatedAt` timestamps
- Compute a 30-day baseline distribution (days -37 to -7)
- Compute a 7-day current distribution (last 7 days)
- Calculate Jensen-Shannon divergence between the two distributions
- A JSD > 0.1 (or whatever threshold PR #288 used) signals degradation

### Step 3: Add `lastDriftCheckAt` to Supervisor state type

In `lib/atc/types.ts` (or wherever `SupervisorState` / supervisor agent state is defined), add the `lastDriftCheckAt` field:

```typescript
// Find the SupervisorState or equivalent type and add:
lastDriftCheckAt?: string; // ISO timestamp of last drift check
```

If state is defined inline in `supervisor.ts`, add it there. Follow the exact pattern of other `lastXxxAt` fields already present.

### Step 4: Implement drift detection phase in `lib/atc/supervisor.ts`

Add a new phase to the Supervisor's cycle. The phase should be added after the existing phases (check the current last phase number and increment). Here is the implementation pattern — adapt imports and function signatures to match what actually exists in the codebase:

```typescript
// §N — Drift Detection (at most once per 24h)
async function runDriftDetection(
  ctx: CycleContext, // or whatever context type the Supervisor uses
  state: SupervisorState,
  items: WorkItem[],
): Promise<{ detected: boolean; jsd?: number }> {
  const DRIFT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

  const now = Date.now();
  const lastCheck = state.lastDriftCheckAt
    ? new Date(state.lastDriftCheckAt).getTime()
    : 0;

  if (now - lastCheck < DRIFT_CHECK_INTERVAL_MS) {
    ctx.log?.(`[Supervisor §N] Drift check skipped — last ran ${
      Math.round((now - lastCheck) / 3600000)
    }h ago`);
    return { detected: false };
  }

  // 30-day baseline window: days -37 to -7
  const baselineStart = new Date(now - 37 * 86400000);
  const baselineEnd = new Date(now - 7 * 86400000);
  // 7-day current window: last 7 days
  const currentStart = new Date(now - 7 * 86400000);
  const currentEnd = new Date(now);

  function buildDailyDistribution(
    workItems: WorkItem[],
    start: Date,
    end: Date,
  ): number[] {
    const days = Math.round((end.getTime() - start.getTime()) / 86400000);
    const counts = new Array(days).fill(0);
    for (const item of workItems) {
      const ts = item.mergedAt ?? item.updatedAt ?? item.createdAt;
      if (!ts) continue;
      const t = new Date(ts).getTime();
      if (t < start.getTime() || t >= end.getTime()) continue;
      const dayIndex = Math.floor((t - start.getTime()) / 86400000);
      if (dayIndex >= 0 && dayIndex < days) counts[dayIndex]++;
    }
    return counts;
  }

  function normalize(arr: number[]): number[] {
    const total = arr.reduce((a, b) => a + b, 0);
    if (total === 0) return arr.map(() => 1 / arr.length);
    return arr.map((v) => v / total);
  }

  function klDivergence(p: number[], q: number[]): number {
    let kl = 0;
    for (let i = 0; i < p.length; i++) {
      if (p[i] > 0 && q[i] > 0) kl += p[i] * Math.log(p[i] / q[i]);
    }
    return kl;
  }

  function jensenShannonDivergence(p: number[], q: number[]): number {
    // Pad to equal length
    const len = Math.max(p.length, q.length);
    const pp = [...p, ...new Array(len - p.length).fill(0)];
    const qq = [...q, ...new Array(len - q.length).fill(0)];
    const pn = normalize(pp);
    const qn = normalize(qq);
    const m = pn.map((v, i) => (v + qn[i]) / 2);
    return (klDivergence(pn, m) + klDivergence(qn, m)) / 2;
  }

  const baselineCounts = buildDailyDistribution(items, baselineStart, baselineEnd);
  const currentCounts = buildDailyDistribution(items, currentStart, currentEnd);
  const jsd = jensenShannonDivergence(baselineCounts, currentCounts);

  const DEGRADATION_THRESHOLD = 0.1;
  const degradationDetected = jsd > DEGRADATION_THRESHOLD;

  // Persist snapshot
  try {
    await saveDriftSnapshot({
      timestamp: new Date().toISOString(),
      jsd,
      degradationDetected,
      baselineWindow: { start: baselineStart.toISOString(), end: baselineEnd.toISOString() },
      currentWindow: { start: currentStart.toISOString(), end: currentEnd.toISOString() },
    });
  } catch (snapErr) {
    console.warn('[Supervisor §N] Failed to save drift snapshot:', snapErr);
  }

  if (degradationDetected) {
    ctx.log?.(`[Supervisor §N] Drift DETECTED — JSD=${jsd.toFixed(4)} (threshold=${DEGRADATION_THRESHOLD})`);
    try {
      await sendDriftAlert(jsd); // implement below using lib/gmail.ts
    } catch (emailErr) {
      console.warn('[Supervisor §N] Failed to send drift alert email:', emailErr);
    }
  } else {
    ctx.log?.(`[Supervisor §N] No drift detected — JSD=${jsd.toFixed(4)}`);
  }

  return { detected: degradationDetected, jsd };
}
```

**Important:** Adapt the above to match actual types, function signatures, and import patterns in the codebase. Check how other phases in `supervisor.ts` are structured and mirror that pattern exactly.

### Step 5: Wire the drift phase into the Supervisor's main cycle

In the Supervisor's main execution function, add the drift phase call:

```typescript
// Inside the main supervisor cycle function, after existing phases:
// §N — Drift Detection
try {
  const driftResult = await runDriftDetection(ctx, state, allWorkItems);
  if (driftResult.detected) {
    events.push({ type: 'drift_detected', jsd: driftResult.jsd });
  }
  // Update state with lastDriftCheckAt
  state.lastDriftCheckAt = new Date().toISOString();
} catch (err) {
  console.warn('[Supervisor §N] Drift detection phase failed (non-fatal):', err);
}
// Save updated state (follow existing pattern for how state is persisted)
```

Check whether the Supervisor saves state at the end of its cycle or per-phase, and follow that pattern.

### Step 6: Implement `sendDriftAlert` using `lib/gmail.ts`

Look at how `lib/gmail.ts` is used elsewhere to send emails, then implement:

```typescript
async function sendDriftAlert(jsd: number): Promise<void> {
  // Use the existing sendEmail / sendGmailMessage / equivalent function
  // Mirror the exact import and call pattern used elsewhere in the codebase
  await sendEmail({
    to: 'james.stine.heath@gmail.com', // or whatever the configured recipient is
    subject: `[Agent Forge] Drift Alert — JSD=${jsd.toFixed(4)}`,
    body: [
      'Agent Forge Supervisor detected statistical drift in work item throughput.',
      '',
      `Jensen-Shannon Divergence: ${jsd.toFixed(4)} (threshold: 0.1)`,
      '',
      'This indicates the 7-day throughput distribution has diverged from the 30-day baseline.',
      'Check the dashboard for more details.',
    ].join('\n'),
  });
}
```

Adapt the function name, parameters, and import to match what `lib/gmail.ts` actually exports.

### Step 7: Handle the case where `lib/drift.ts` doesn't exist or `saveDriftSnapshot` is missing

If `saveDriftSnapshot` does not exist anywhere in the codebase, implement a lightweight version inline in `supervisor.ts` using the existing storage patterns from `lib/storage.ts`:

```typescript
// Only implement this if saveDriftSnapshot doesn't already exist
interface DriftSnapshot {
  timestamp: string;
  jsd: number;
  degradationDetected: boolean;
  baselineWindow: { start: string; end: string };
  currentWindow: { start: string; end: string };
}

async function saveDriftSnapshot(snapshot: DriftSnapshot): Promise<void> {
  // Use the existing storage utility — check lib/storage.ts for the correct function
  // Pattern: saveBlob(`af-data/drift/${snapshot.timestamp}.json`, JSON.stringify(snapshot))
  // Or: put(`af-data/drift/${snapshot.timestamp}.json`, snapshot)
  // Mirror whatever pattern lib/storage.ts uses for other af-data/* blobs
  const key = `af-data/drift/${snapshot.timestamp.replace(/[:.]/g, '-')}.json`;
  await save(key, JSON.stringify(snapshot, null, 2)); // adapt to actual storage API
}
```

If `lib/drift.ts` already exists with `saveDriftSnapshot`, import and use it directly.

### Step 8: Verify no changes were made to `lib/atc.ts`

```bash
git diff lib/atc.ts
# Must show no changes
```

### Step 9: TypeScript verification

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues to watch for:
- `lastDriftCheckAt` not in the state type → add it to the correct type definition
- Import paths for `saveDriftSnapshot`, `sendEmail`, or storage functions
- `WorkItem` type may not have `mergedAt` — check `lib/types.ts` and use the correct field name

### Step 10: Build verification

```bash
npm run build
```

### Step 11: Run existing tests

```bash
npm test 2>/dev/null || echo "No test suite configured"
```

### Step 12: Confirm `lib/atc.ts` is unchanged

```bash
git status
git diff --name-only
# lib/atc.ts must NOT appear in the diff
```

### Step 13: Commit, push, open PR

```bash
git add -A
git commit -m "feat: move drift detection from ATC to Supervisor agent

- Add drift detection phase (once per 24h) to Supervisor cron cycle
- Gate runs with lastDriftCheckAt in Supervisor agent state
- Compute Jensen-Shannon divergence: 30-day baseline vs 7-day window
- Persist snapshots to af-data/drift/ via saveDriftSnapshot
- Send email alert on degradation; fall back to logged warning on failure
- Entire phase wrapped in try/catch (non-fatal)
- No changes to lib/atc.ts (deprecated monolith)

Closes #288"

git push origin feat/supervisor-drift-detection

gh pr create \
  --title "feat: move drift detection from ATC to Supervisor agent" \
  --body "## Summary

Moves drift detection from the legacy ATC monolith to the Supervisor agent, where it belongs per ADR-010.

## Changes
- \`lib/atc/supervisor.ts\`: New drift detection phase (§N) gated by 24h interval
- \`lib/atc/types.ts\` (or inline): Added \`lastDriftCheckAt\` to Supervisor state
- If \`lib/drift.ts\` was missing: Added \`saveDriftSnapshot\` inline using storage utils

## Behavior
- Runs at most once per 24h within the 10-minute Supervisor cron cycle
- Computes Jensen-Shannon divergence between 30-day baseline and 7-day current window
- Persists snapshot to \`af-data/drift/\`
- Sends email alert on degradation (threshold: JSD > 0.1); logs warning on email failure
- Entire phase is non-fatal (try/catch wrapped)

## Not Changed
- \`lib/atc.ts\` — untouched (deprecated monolith)

## Concurrent Work
No file overlap with \`fix/dashboard-qa-results-section-api-route\` (\`app/api/qa-results/route.ts\`).
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/supervisor-drift-detection
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed or is ambiguous]
NEXT STEPS: [what remains]
```

## Key Ambiguity Notes for the Executor

Before writing any code, the executor **must** read:
1. `lib/atc/supervisor.ts` — understand the cycle structure, state shape, context type, how phases are numbered, how state is persisted
2. `lib/atc/types.ts` — find `SupervisorState` or equivalent, understand what `lastXxxAt` fields look like
3. `lib/drift.ts` or equivalent — check if `saveDriftSnapshot` already exists
4. `lib/gmail.ts` — find the correct function name and signature for sending emails
5. `lib/storage.ts` — understand the blob storage API if `saveDriftSnapshot` needs to be implemented
6. `lib/types.ts` — confirm the correct field names on `WorkItem` (e.g., `mergedAt`, `updatedAt`, `completedAt`)

Do not assume any function name or import path — verify from the actual source files first.