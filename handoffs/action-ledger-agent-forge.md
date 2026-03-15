# Action Ledger: Persistent Outcome History for Agent Forge

## Metadata
- **ID(s):** action-ledger-agent-forge
- **Type:** enhancement
- **Priority:** high (predecessor to Feedback Compiler)
- **Risk:** low (additive change, no existing behavior modified)
- **Complexity:** simple
- **Model:** claude-opus-4-6
- **Estimated files:** .github/actions/tlm-outcome-tracker/src/index.ts, .github/actions/tlm-outcome-tracker/dist/index.js, docs/tlm-action-ledger.json
- **Execution mode:** Autonomous
- **Depends on:** Outcome Tracker (merged)
- **Max Budget:** $3

## Context

The Outcome Tracker currently writes assessments to `docs/tlm-memory.md`, which maintains a rolling window of the last 20 outcomes. Older entries are pruned. The upcoming Feedback Compiler (ADR-009, handoff `feedback-compiler-v1`) needs historical depth to compute baselines and detect trends, but that data evaporates after 20 entries.

This handoff adds a persistent Action Ledger (`docs/tlm-action-ledger.json`) that the Outcome Tracker appends to on every run. The ledger grows over time and is never pruned. The memory file continues to serve as the rolling working memory that agents read on each run. The ledger serves as the historical archive that the Feedback Compiler reads for pattern analysis.

This implements the Action Ledger concept from ADR-007 (in the PA repo) using repo-based storage rather than Vercel Blob, which is appropriate for TLM agents that run in GitHub Actions.

## Step 0: Branch and Orient

1. Create branch `action-ledger` from `main`.
2. Read these files:
   - `.github/actions/tlm-outcome-tracker/src/index.ts` (the full Outcome Tracker implementation)
   - `.github/workflows/tlm-outcome-tracker.yml` (to understand the commit step that needs to include the new file)
   - `docs/tlm-memory.md` (current memory format for reference)
3. Commit this handoff file to the branch and push.

## Step 1: Define the ledger entry schema

Add these interfaces to the top of `.github/actions/tlm-outcome-tracker/src/index.ts` (alongside the existing interfaces):

```typescript
interface LedgerEntry {
  entryId: string;                // unique: `${repo}-${pr_number}-${assessed_at}`
  repo: string;                   // e.g. "agent-forge"
  agentType: string;              // "tlm-code-reviewer" for now
  prNumber: number;
  prTitle: string;
  mergedAt: string;               // ISO date
  assessedAt: string;             // ISO date
  outcome: string;                // from universal taxonomy
  confidence: string;             // high/medium/low
  evidence: string;               // from Claude's assessment
  lessons: string;                // from Claude's assessment
  tlmDecision: string;            // what the Code Reviewer decided
  changedFiles: string[];         // files touched by the PR
  fixCommits: number;             // count of subsequent fix commits
}

interface ActionLedger {
  version: 1;
  entries: LedgerEntry[];
  lastUpdated: string;            // ISO date
}
```

## Step 2: Add ledger read/write functions

Add these functions to `index.ts`:

```typescript
function loadLedger(workspace: string): ActionLedger {
  const ledgerPath = path.join(workspace, "docs", "tlm-action-ledger.json");
  try {
    const content = fs.readFileSync(ledgerPath, "utf-8");
    return JSON.parse(content) as ActionLedger;
  } catch {
    core.info("No existing action ledger, creating new one.");
    return { version: 1, entries: [], lastUpdated: "" };
  }
}

function saveLedger(workspace: string, ledger: ActionLedger): void {
  const ledgerPath = path.join(workspace, "docs", "tlm-action-ledger.json");
  const docsDir = path.join(workspace, "docs");
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf-8");
  core.info(`Updated action ledger at ${ledgerPath} (${ledger.entries.length} total entries)`);
}
```

## Step 3: Wire ledger writes into the run() function

In the `run()` function, after the existing loop that updates `memory.recent_outcomes` and `memory.stats`, add ledger writes:

1. Load the ledger at the start of `run()` (after loading memory):
   ```typescript
   const ledger = loadLedger(workspace);
   ```

2. Inside the existing `for (const assessment of result.assessments)` loop, after the memory update logic, append a ledger entry:
   ```typescript
   const context = github.context;
   ledger.entries.push({
     entryId: `${repo}-${assessment.pr_number}-${now}`,
     repo,
     agentType: "tlm-code-reviewer",
     prNumber: assessment.pr_number,
     prTitle: prInfo.title,
     mergedAt: prInfo.merged_at.split("T")[0],
     assessedAt: now,
     outcome: mappedOutcome,
     confidence: assessment.confidence,
     evidence: assessment.evidence,
     lessons: assessment.lessons,
     tlmDecision: prInfo.tlm_decision,
     changedFiles: prInfo.changed_files,
     fixCommits: prInfo.fix_commits.length,
   });
   ```

3. After writing the memory file, save the ledger:
   ```typescript
   ledger.lastUpdated = now;
   saveLedger(workspace, ledger);
   ```

## Step 4: Update the workflow to commit the ledger

In `.github/workflows/tlm-outcome-tracker.yml`, update the "Commit memory updates" step to also stage the ledger file:

```yaml
      - name: Commit memory updates
        run: |
          git config user.name "TLM Outcome Tracker"
          git config user.email "tlm@github-actions"
          git add docs/tlm-memory.md docs/tlm-action-ledger.json
          git diff --cached --quiet || git commit -m "chore(tlm): update review memory and action ledger"
          git push
```

## Step 5: Initialize the ledger with existing data

Create `docs/tlm-action-ledger.json` with an initial state that backfills from the current `docs/tlm-memory.md`. Read the Recent Outcomes table from the memory file and convert each entry to a LedgerEntry. For backfilled entries, set `confidence` to "unknown", `evidence` to "Backfilled from tlm-memory.md", `lessons` to empty string, `tlmDecision` to "unknown", `changedFiles` to empty array, and `fixCommits` to 0. This preserves existing outcome history so the Feedback Compiler has data from day one.

If backfilling is too complex, initialize with:
```json
{
  "version": 1,
  "entries": [],
  "lastUpdated": null
}
```

The Outcome Tracker will start populating it on its next run.

## Step 6: Build and verify

1. `cd .github/actions/tlm-outcome-tracker && npm install && npm run build` to produce updated `dist/index.js`.
2. `npm run typecheck` to verify no type errors.
3. Verify the workflow YAML is valid and includes the new `git add` path.
4. Verify `docs/tlm-action-ledger.json` exists and is valid JSON.
5. Commit the updated `dist/index.js`.

## Pre-flight Self-Check

- [ ] The ledger write is additive only. No existing behavior (memory file writes, stats updates, annotations) is changed.
- [ ] The `loadLedger` function handles missing file gracefully (returns empty ledger).
- [ ] The `saveLedger` function creates the docs directory if needed.
- [ ] The `entryId` format is deterministic and unique per assessment.
- [ ] The workflow commits both `docs/tlm-memory.md` and `docs/tlm-action-ledger.json`.
- [ ] The `dist/index.js` is rebuilt and committed.
- [ ] No secrets or sensitive data in ledger entries.

## Session Abort Protocol

If execution cannot complete:
1. Commit all work in progress to the branch.
2. Push the branch.
3. Output structured status:
```
ABORT: action-ledger-agent-forge
COMPLETED: [list of completed steps]
REMAINING: [list of remaining steps]
BLOCKER: [description]
```
