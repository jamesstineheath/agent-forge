<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Deprecate ATC Monolith Cron — Verify Agents Cover All Responsibilities Then Disable

## Metadata
- **Branch:** `feat/deprecate-atc-monolith-cron`
- **Priority:** high
- **Model:** opus
- **Type:** refactor
- **Max Budget:** $5
- **Risk Level:** high
- **Estimated files:** vercel.json, lib/atc.ts, docs/SYSTEM_MAP.md, lib/orchestrator.ts, lib/decomposer.ts, lib/atc/dispatcher.ts, lib/atc/health-monitor.ts, lib/pm-agent.ts, app/api/agents/supervisor/cron/route.ts

## Context

The Agent Forge control plane has undergone a major architectural shift (ADR-010): the ATC monolith (`lib/atc.ts`, `/api/atc/cron`) has been decomposed into 4 autonomous agents:

| Agent | Cron Route | Cadence |
|-------|-----------|---------|
| Dispatcher | `/api/agents/dispatcher/cron` | 5 min |
| Health Monitor | `/api/agents/health-monitor/cron` | 5 min |
| Project Manager | `/api/pm-agent` | 15 min |
| Supervisor | `/api/agents/supervisor/cron` | 10 min |

However, the **ATC monolith cron is still active** in `vercel.json`, running every 5 minutes in parallel. This creates:
1. Duplicate work (same items dispatched/checked twice)
2. Race conditions between the monolith and agents on the distributed lock
3. The monolith remains the de facto system because it always runs
4. Confusion for the pipeline generator — new handoffs still target `lib/atc.ts` instead of agent-specific files

This handoff performs a careful audit, documents any gaps as filed work items, then disables the ATC cron (without deleting code).

**Concurrent work to avoid:** `fix/dashboard-qa-results-section-api-route` touches `app/api/qa-results/route.ts` — no overlap with this work.

## Requirements

1. Audit every section of `lib/atc.ts` and verify it maps to a specific agent file/function — document the mapping in a table
2. For any section with no agent coverage, document the gap clearly (do NOT implement the fix in this handoff — file a separate work item via the escalation mechanism or document it in the PR)
3. Remove the `/api/atc/cron` cron entry from `vercel.json` (feature-flag check: if `AGENT_SPLIT_ENABLED` guards it, confirm the flag is always true in prod before removing)
4. Add a deprecation notice at the top of `lib/atc.ts` — do NOT delete the file or any functions
5. Update `docs/SYSTEM_MAP.md` to mark the ATC monolith as disabled/deprecated
6. Update `lib/orchestrator.ts` and/or `lib/decomposer.ts` so the context injected into handoff generation references the agent-specific files (`lib/atc/dispatcher.ts`, `lib/atc/health-monitor.ts`, etc.) rather than `lib/atc.ts`
7. All TypeScript must compile with no new errors (`npx tsc --noEmit`)
8. No regression: existing agent cron routes must remain fully intact and unmodified

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/deprecate-atc-monolith-cron
```

### Step 1: Read and map the ATC monolith

Read `lib/atc.ts` in full. Also read the four agent files:
- `lib/atc/dispatcher.ts`
- `lib/atc/health-monitor.ts`
- `lib/pm-agent.ts`
- `app/api/agents/supervisor/cron/route.ts`

Also read `vercel.json` to see the current cron configuration.

Build a complete section-by-section mapping. The known structure from the description is:

| ATC Section | Description | Expected Agent |
|-------------|-------------|----------------|
| §0 | Index reconciliation | Dispatcher |
| §1-2 | Dispatch logic | Dispatcher |
| §2.7 | Merge conflict repair | Health Monitor |
| §2.8 | Failed item reconciliation | Health Monitor |
| §3 | Stall detection | Health Monitor |
| §4 | Project retry | Project Manager |
| §13 | Project completion | Project Manager |
| §14 | PM daily sweep | Project Manager |
| §15 | HLO state polling | Health Monitor |
| Branch cleanup | Stale branch removal | Supervisor |

For each row, confirm whether the agent file actually implements it. Note the specific function name(s) in the agent file that handle it.

**Decision tree for each section:**
- ✅ **Covered**: Agent file has clear implementation → mark covered
- ⚠️ **Partial**: Agent has stub/incomplete logic → mark partial, note what's missing
- ❌ **Gap**: No agent handles this → mark gap, this will become a filed work item note in the PR

### Step 2: Document the audit in a file

Create `docs/atc-deprecation-audit.md` with the full mapping table from Step 1. Format:

```markdown
# ATC Deprecation Audit

Generated as part of `feat/deprecate-atc-monolith-cron`.

## Coverage Map

| ATC Section | Description | Agent | File | Function(s) | Status |
|-------------|-------------|-------|------|-------------|--------|
| §0 | Index reconciliation | Dispatcher | lib/atc/dispatcher.ts | `reconcileIndex` | ✅ Covered |
| ... | | | | | |

## Gaps (require separate work items)

_List any ❌ or ⚠️ items here with enough detail to file a work item._

## Decision

All gaps documented above. ATC cron safe to disable: [YES/NO]
```

If any `❌ Gap` items exist that are **safety-critical** (e.g., stall detection is entirely missing), set the decision to NO and **do not proceed to Steps 3–5**. Instead, skip to Step 6 (escalate) and still do Step 7 (commit what you have with a clear PR description).

If all gaps are minor (partial coverage, not complete absence of critical safety logic), proceed.

### Step 3: Add deprecation notice to lib/atc.ts

At the very top of `lib/atc.ts`, before any imports or after the file's leading comments, add:

```typescript
/**
 * @deprecated ATC Monolith — DISABLED as of [current date]
 *
 * This file is preserved for reference and utility function imports.
 * The cron route `/api/atc/cron` has been removed from vercel.json.
 *
 * Responsibilities have been migrated to autonomous agents:
 *   - Dispatch logic       → lib/atc/dispatcher.ts
 *   - Health monitoring    → lib/atc/health-monitor.ts
 *   - Project management   → lib/pm-agent.ts
 *   - Supervision          → app/api/agents/supervisor/cron/route.ts
 *
 * See docs/atc-deprecation-audit.md for the full coverage map.
 * See ADR-010 for the architectural decision.
 *
 * DO NOT DELETE — agents may import utility functions from this file.
 * DO NOT RE-ENABLE the cron unless all 4 agents are confirmed non-functional.
 */
```

Do **not** modify any function bodies, exports, or imports in `lib/atc.ts`.

### Step 4: Remove ATC cron from vercel.json

Read `vercel.json`. Find the cron entry for `/api/atc/cron`. It will look something like:

```json
{
  "path": "/api/atc/cron",
  "schedule": "*/5 * * * *"
}
```

Remove **only** that entry from the `crons` array. Leave all other cron entries (dispatcher, health-monitor, pm-agent, supervisor) completely untouched.

Verify the remaining cron entries are:
- `/api/agents/dispatcher/cron` (5 min)
- `/api/agents/health-monitor/cron` (5 min)  
- `/api/pm-agent` (15 min)
- `/api/agents/supervisor/cron` (10 min)
- Any other non-ATC crons (feedback compiler, etc.) — leave them alone

### Step 5: Update docs/SYSTEM_MAP.md

Find the section that references the ATC monolith cron. Update accordingly:

1. In the agents table (if present), mark the ATC monolith row as `[DISABLED]` or remove it and add a note
2. Find any sentence like "Legacy `/api/atc/cron` still works as fallback" and update it to:
   > Legacy `/api/atc/cron` **has been disabled** (removed from vercel.json). `lib/atc.ts` is preserved as a reference and for utility function imports. See `docs/atc-deprecation-audit.md`.
3. In the Key Files table, update the ATC (legacy) row to note it is disabled:
   > `lib/atc.ts` | Backward-compat orchestrator **[DEPRECATED/DISABLED]** — cron removed, file preserved

Do not rewrite large sections of SYSTEM_MAP.md — make surgical targeted edits only.

### Step 6: Update orchestrator/decomposer context to target agent files

The goal is that when the orchestrator or decomposer generates context for new handoffs, it references the agent-specific files rather than `lib/atc.ts`.

Read `lib/orchestrator.ts` and `lib/decomposer.ts`. Look for:
- Any hardcoded string `"lib/atc.ts"` or `"lib/atc"` in context-building or file-listing logic
- Any prompt templates that mention `lib/atc.ts` as the primary file to edit
- Any system prompt construction that lists `lib/atc.ts` as "the ATC file"

If found, update those references to list the specific agent files. Example change:

```typescript
// Before:
const keyFiles = ["lib/atc.ts", "lib/work-items.ts", ...];

// After:
const keyFiles = [
  "lib/atc/dispatcher.ts",      // Dispatch logic, conflict detection
  "lib/atc/health-monitor.ts",  // Stall detection, recovery
  "lib/pm-agent.ts",            // Project management
  "app/api/agents/supervisor/cron/route.ts", // Supervision
  // lib/atc.ts is deprecated — do not target for new work
  "lib/work-items.ts",
  ...
];
```

If `lib/orchestrator.ts` or `lib/decomposer.ts` do **not** have hardcoded file references (they may dynamically read CLAUDE.md and SYSTEM_MAP.md from the target repo instead), then this step is satisfied by the SYSTEM_MAP.md update in Step 5 — note this in the PR description.

### Step 7: TypeScript check and build verification

```bash
npx tsc --noEmit
```

Fix any TypeScript errors introduced. The deprecation comment block must use `/** */` JSDoc syntax, not inline `//` comments, to avoid TS parse issues.

If you see errors in files you did NOT modify, note them in the PR but do not fix them (pre-existing issues).

### Step 8: Verification checklist

Before committing, manually verify:

```bash
# 1. Confirm ATC cron is gone from vercel.json
grep -n "atc/cron" vercel.json
# Expected: no output (or only agent cron routes, not the monolith)

# 2. Confirm deprecation notice is in lib/atc.ts
head -30 lib/atc.ts
# Expected: deprecation block visible

# 3. Confirm agent cron routes still exist in vercel.json
grep -n "agents/dispatcher\|agents/health-monitor\|pm-agent\|agents/supervisor" vercel.json
# Expected: 4 entries

# 4. Confirm audit doc was created
ls -la docs/atc-deprecation-audit.md

# 5. Confirm no accidental deletions
git diff --stat
# Should show: vercel.json, lib/atc.ts, docs/SYSTEM_MAP.md, docs/atc-deprecation-audit.md (new), 
#              and possibly lib/orchestrator.ts or lib/decomposer.ts
```

### Step 9: Run tests if available

```bash
npm test 2>/dev/null || echo "No test suite configured"
npm run build 2>/dev/null || echo "Build not applicable for library"
```

### Step 10: Commit, push, open PR

```bash
git add -A
git commit -m "refactor: deprecate ATC monolith cron — agents cover all responsibilities

- Remove /api/atc/cron from vercel.json (4 autonomous agents now handle all work)
- Add deprecation notice to lib/atc.ts (file preserved for utility imports)
- Add docs/atc-deprecation-audit.md with section-by-section coverage map
- Update SYSTEM_MAP.md to reflect ATC monolith is disabled
- Update orchestrator/decomposer context to target agent-specific files

ADR-010: ATC Monolith → Autonomous Agent Architecture
Resolves: duplicate dispatch work, race conditions on distributed lock"

git push origin feat/deprecate-atc-monolith-cron

gh pr create \
  --title "refactor: deprecate ATC monolith cron — disable after full agent coverage verified" \
  --body "## Summary

Disables the ATC monolith cron (\`/api/atc/cron\`) after verifying that all 4 autonomous agents (Dispatcher, Health Monitor, Project Manager, Supervisor) cover its responsibilities.

## Changes

- **\`vercel.json\`**: Removed \`/api/atc/cron\` cron entry. All 4 agent cron routes remain active.
- **\`lib/atc.ts\`**: Added deprecation JSDoc notice at top of file. No code deleted — utility functions still importable.
- **\`docs/atc-deprecation-audit.md\`** (new): Section-by-section coverage map with agent → function mappings.
- **\`docs/SYSTEM_MAP.md\`**: Updated to note ATC monolith is disabled/deprecated.
- **\`lib/orchestrator.ts\` / \`lib/decomposer.ts\`**: Updated context to reference agent-specific files (or confirmed SYSTEM_MAP.md update is sufficient).

## Coverage Audit

See \`docs/atc-deprecation-audit.md\` for the full table. Summary:

<!-- paste the coverage table from the audit doc here -->

## Gaps Filed as Work Items

<!-- list any gaps found, or state 'None — full coverage confirmed' -->

## Risk Mitigation

- \`lib/atc.ts\` is NOT deleted — rollback is trivial (re-add the cron entry to vercel.json)
- All 4 agent cron routes verified present in vercel.json post-change
- TypeScript compiles cleanly (\`npx tsc --noEmit\` passes)

## Rollback Plan

If pipeline issues emerge after merge:
\`\`\`bash
# Re-add to vercel.json crons array:
{ \"path\": \"/api/atc/cron\", \"schedule\": \"*/5 * * * *\" }
\`\`\`
This immediately re-enables the monolith without any code changes."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit whatever has been completed (audit doc at minimum is valuable even without the cron removal)
2. Push and open PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/deprecate-atc-monolith-cron
FILES CHANGED: [list what was actually modified]
SUMMARY: [what was completed — e.g., "Audit complete, gaps documented. Cron removal not yet done."]
ISSUES: [what failed or was blocked]
NEXT STEPS: [e.g., "Step 4: Remove ATC cron from vercel.json", "Step 6: Update orchestrator context"]
```

## Critical Decision Gate

**Do NOT remove the ATC cron (Step 4) if the audit (Step 1–2) reveals that any of these are completely unhandled by agents:**

- Dispatch of ready work items (critical path)
- Stall detection and recovery (items would get stuck forever)
- Project completion detection (projects would never close)

If any of these are unhandled, escalate instead of proceeding:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "deprecate-atc-monolith-cron",
    "reason": "Audit revealed critical gap: [SECTION] has no agent coverage. Cannot safely disable ATC cron until gap is filled.",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "2",
      "error": "Gap detected in coverage: [describe gap]",
      "filesChanged": ["docs/atc-deprecation-audit.md"]
    }
  }'
```

Then open a PR with just the audit doc and the partial deprecation notice — that work is still valuable.