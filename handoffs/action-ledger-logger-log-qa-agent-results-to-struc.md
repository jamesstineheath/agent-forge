# Agent Forge -- Action Ledger Logger — Log QA Agent Results to Structured Ledger

## Metadata
- **Branch:** `feat/qa-agent-action-ledger-logger`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** .github/actions/tlm-qa-agent/src/action-ledger.ts, .github/actions/tlm-qa-agent/src/index.ts, .github/actions/tlm-qa-agent/dist/index.js

## Context

The TLM QA Agent (`/.github/actions/tlm-qa-agent/`) is a composite GitHub Action that runs smoke tests and produces pass/fail verdicts after deployments. Currently, results are ephemeral — they exist only in workflow logs.

This task adds persistence by introducing an Action Ledger logger. After each QA agent run, a structured JSON entry is appended to `docs/tlm-action-ledger.json` and committed back to the repo. This follows the same pattern already used by the TLM Outcome Tracker's git push step.

The ledger entry format must be compatible with the universal outcome taxonomy (`Correct`, `Reversed`, `Caused Issues`, `Missed`, `Premature`) used by the Outcome Tracker, so an `assessedOutcome` field is included (nullable, filled later by Outcome Tracker).

Key existing patterns in this repo:
- TypeScript source lives in `.github/actions/tlm-qa-agent/src/`, bundled via `ncc` into `.github/actions/tlm-qa-agent/dist/index.js`
- The Outcome Tracker appends JSON and commits+pushes — replicate that git pattern here
- `docs/tlm-action-ledger.json` is the target ledger file (referenced in SYSTEM_MAP as in-pipeline)

## Requirements

1. Create `.github/actions/tlm-qa-agent/src/action-ledger.ts` with an exported `QAActionLedgerEntry` type and `logToActionLedger(entry: QAActionLedgerEntry)` function
2. `QAActionLedgerEntry` must include: `timestamp`, `agentType: 'qa-agent'`, `prNumber`, `repo`, `outcome: 'pass' | 'fail'`, `smokeTestResults: Array<{name, passed, durationMs, error?}>`, `acceptanceCriteriaVerdicts: Array<{criterion, verdict: 'pass' | 'fail' | 'skip', evidence?}>`, `totalDurationMs`, `deployUrl`, `runId`, `assessedOutcome: string | null`
3. `logToActionLedger` reads `docs/tlm-action-ledger.json`; if it does not exist, initializes with `[]` before appending
4. After appending, `logToActionLedger` commits and pushes the updated ledger file using child_process `execSync` (same pattern as outcome tracker)
5. `.github/actions/tlm-qa-agent/src/index.ts` is updated to call `logToActionLedger` after producing results
6. `dist/index.js` is rebuilt with `ncc` to include the new module
7. No new external runtime dependencies (use Node built-ins: `fs`, `path`, `child_process`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/qa-agent-action-ledger-logger
```

### Step 1: Inspect existing source files

Read the existing QA agent source to understand its structure before modifying:

```bash
cat .github/actions/tlm-qa-agent/src/index.ts
ls .github/actions/tlm-qa-agent/src/
cat .github/actions/tlm-qa-agent/package.json
# Also check outcome tracker for git commit+push pattern reference
cat .github/actions/tlm-outcome-tracker/src/index.ts 2>/dev/null || \
  ls .github/actions/tlm-outcome-tracker/src/
```

Note the exact shape of the QA results object produced in `index.ts` — you'll need to map its fields to `QAActionLedgerEntry`.

### Step 2: Create `.github/actions/tlm-qa-agent/src/action-ledger.ts`

Create the new file with the following content (adjust import paths if needed based on what you found in Step 1):

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface SmokeTestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

export interface AcceptanceCriteriaVerdict {
  criterion: string;
  verdict: 'pass' | 'fail' | 'skip';
  evidence?: string;
}

export interface QAActionLedgerEntry {
  timestamp: string;           // ISO 8601
  agentType: 'qa-agent';
  prNumber: number | null;
  repo: string;
  outcome: 'pass' | 'fail';
  smokeTestResults: SmokeTestResult[];
  acceptanceCriteriaVerdicts: AcceptanceCriteriaVerdict[];
  totalDurationMs: number;
  deployUrl: string | null;
  runId: string;
  assessedOutcome: string | null;  // Filled later by Outcome Tracker; null on creation
}

const LEDGER_PATH = path.resolve(process.cwd(), 'docs', 'tlm-action-ledger.json');

export async function logToActionLedger(entry: QAActionLedgerEntry): Promise<void> {
  console.log('[action-ledger] Writing entry to ledger...');

  // Ensure docs/ directory exists
  const docsDir = path.dirname(LEDGER_PATH);
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  // Read existing ledger or initialize empty array
  let ledger: QAActionLedgerEntry[] = [];
  if (fs.existsSync(LEDGER_PATH)) {
    try {
      const raw = fs.readFileSync(LEDGER_PATH, 'utf-8');
      ledger = JSON.parse(raw);
      if (!Array.isArray(ledger)) {
        console.warn('[action-ledger] Ledger file was not an array — reinitializing');
        ledger = [];
      }
    } catch (err) {
      console.warn('[action-ledger] Failed to parse existing ledger, reinitializing:', err);
      ledger = [];
    }
  } else {
    console.log('[action-ledger] Ledger file not found, creating new one');
  }

  // Append new entry
  ledger.push(entry);

  // Write back
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n', 'utf-8');
  console.log(`[action-ledger] Ledger updated. Total entries: ${ledger.length}`);

  // Commit and push
  try {
    execSync('git config user.email "tlm-qa-agent@agent-forge.bot"', { stdio: 'inherit' });
    execSync('git config user.name "TLM QA Agent"', { stdio: 'inherit' });
    execSync(`git add ${LEDGER_PATH}`, { stdio: 'inherit' });

    // Check if there are staged changes before committing
    const diff = execSync('git diff --cached --name-only').toString().trim();
    if (!diff) {
      console.log('[action-ledger] No changes to commit (ledger unchanged)');
      return;
    }

    const commitMsg = `chore: tlm-qa-agent ledger entry [run ${entry.runId}]`;
    execSync(`git commit -m "${commitMsg}"`, { stdio: 'inherit' });
    execSync('git push', { stdio: 'inherit' });
    console.log('[action-ledger] Ledger committed and pushed successfully');
  } catch (err) {
    // Non-fatal: log the error but don't fail the QA run
    console.error('[action-ledger] Failed to commit/push ledger update:', err);
  }
}
```

### Step 3: Update `.github/actions/tlm-qa-agent/src/index.ts`

After reading `index.ts` in Step 1, locate where the QA agent finalizes its results (the pass/fail verdict). Add the import and the `logToActionLedger` call at that point.

At the top of `index.ts`, add:
```typescript
import { logToActionLedger, QAActionLedgerEntry } from './action-ledger';
```

After the QA run produces results (before or after setting output variables), build the ledger entry and call `logToActionLedger`. Example of what to add — adapt field names to match the actual result object in `index.ts`:

```typescript
// Build ledger entry from QA results
const ledgerEntry: QAActionLedgerEntry = {
  timestamp: new Date().toISOString(),
  agentType: 'qa-agent',
  prNumber: prNumber ? parseInt(prNumber, 10) : null,
  repo: process.env.GITHUB_REPOSITORY ?? '',
  outcome: overallPassed ? 'pass' : 'fail',
  smokeTestResults: smokeTestResults ?? [],   // map from actual results shape
  acceptanceCriteriaVerdicts: criteriaVerdicts ?? [],  // map from actual results shape
  totalDurationMs: totalDurationMs ?? 0,
  deployUrl: deployUrl ?? null,
  runId: process.env.GITHUB_RUN_ID ?? 'unknown',
  assessedOutcome: null,
};

await logToActionLedger(ledgerEntry);
```

**Important:** The exact field names (`prNumber`, `overallPassed`, `smokeTestResults`, `criteriaVerdicts`, `totalDurationMs`, `deployUrl`) must match what `index.ts` actually computes. Read the file carefully and adapt accordingly. The key requirement is that `logToActionLedger` is called with a fully populated `QAActionLedgerEntry` after results are available.

If `index.ts` does not have some fields (e.g., `smokeTestResults` as an array), construct them from whatever data is available — even if that means an empty array with a note. Do not break existing functionality.

### Step 4: Verify TypeScript compilation

```bash
cd .github/actions/tlm-qa-agent
npx tsc --noEmit
```

Fix any type errors before proceeding.

### Step 5: Rebuild the dist bundle

```bash
cd .github/actions/tlm-qa-agent
npm run build
```

If there is no `build` script, check `package.json`. The typical command for ncc is:
```bash
npx @vercel/ncc build src/index.ts -o dist --license licenses.txt
```

Or if ncc is in devDependencies:
```bash
./node_modules/.bin/ncc build src/index.ts -o dist
```

Verify the bundle was updated:
```bash
ls -lh dist/index.js
# Should show recent modification time
grep -l "action-ledger" dist/index.js && echo "action-ledger included" || echo "WARNING: not found in bundle"
```

### Step 6: Smoke-check the ledger schema

Quickly verify the output shape by running a Node.js snippet (optional sanity check):
```bash
node -e "
const { execSync } = require('child_process');
// Just verify the dist bundle compiles without immediate errors
console.log('dist/index.js size:', require('fs').statSync('.github/actions/tlm-qa-agent/dist/index.js').size, 'bytes');
"
```

### Step 7: Verification

```bash
# TypeScript check from repo root
npx tsc --noEmit 2>/dev/null || cd .github/actions/tlm-qa-agent && npx tsc --noEmit

# Confirm new file exists
test -f .github/actions/tlm-qa-agent/src/action-ledger.ts && echo "✓ action-ledger.ts exists"

# Confirm index.ts imports action-ledger
grep -n "action-ledger" .github/actions/tlm-qa-agent/src/index.ts && echo "✓ index.ts references action-ledger"

# Confirm dist was rebuilt
test -f .github/actions/tlm-qa-agent/dist/index.js && echo "✓ dist/index.js exists"

# Run repo-level tests if any exist
npm test 2>/dev/null || echo "No root-level tests"
```

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add action ledger logger to TLM QA Agent

- Add src/action-ledger.ts with QAActionLedgerEntry type and logToActionLedger()
- Reads/creates docs/tlm-action-ledger.json, appends structured entry, commits+pushes
- Update src/index.ts to call logToActionLedger after QA results are produced
- Include assessedOutcome: null field for Outcome Tracker compatibility
- Rebuild dist/index.js bundle with ncc"

git push origin feat/qa-agent-action-ledger-logger

gh pr create \
  --title "feat: add action ledger logger to TLM QA Agent" \
  --body "## Summary

Adds persistent structured logging to the TLM QA Agent composite action.

## Changes

- **New**: \`.github/actions/tlm-qa-agent/src/action-ledger.ts\` — implements \`logToActionLedger(entry: QAActionLedgerEntry)\` that reads/creates \`docs/tlm-action-ledger.json\`, appends the entry, and commits+pushes the updated file
- **Modified**: \`.github/actions/tlm-qa-agent/src/index.ts\` — calls \`logToActionLedger\` after QA run completes
- **Rebuilt**: \`.github/actions/tlm-qa-agent/dist/index.js\` — bundle includes new action-ledger module

## Entry Shape

\`\`\`typescript
interface QAActionLedgerEntry {
  timestamp: string;
  agentType: 'qa-agent';
  prNumber: number | null;
  repo: string;
  outcome: 'pass' | 'fail';
  smokeTestResults: Array<{ name, passed, durationMs, error? }>;
  acceptanceCriteriaVerdicts: Array<{ criterion, verdict: 'pass'|'fail'|'skip', evidence? }>;
  totalDurationMs: number;
  deployUrl: string | null;
  runId: string;
  assessedOutcome: string | null;  // Outcome Tracker fills this later
}
\`\`\`

## Compatibility

- \`assessedOutcome: null\` on creation — compatible with universal outcome taxonomy (Correct, Reversed, Caused Issues, Missed, Premature)
- Git commit pattern mirrors TLM Outcome Tracker
- Non-fatal: commit/push failures are logged but do not fail the QA run

## Testing

- TypeScript compiles without errors
- dist bundle rebuilt and includes action-ledger module"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
```bash
git add -A
git commit -m "wip: partial qa-agent action ledger logger implementation"
git push origin feat/qa-agent-action-ledger-logger
```
2. Open the PR with partial status:
```bash
gh pr create --title "wip: add action ledger logger to TLM QA Agent" --body "Partial implementation — see ISSUES below"
```
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/qa-agent-action-ledger-logger
FILES CHANGED: [list modified files]
SUMMARY: [what was completed]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "dist bundle needs rebuild", "index.ts integration pending"]
```

If you encounter an unresolvable blocker (e.g., `index.ts` has no recognizable results object, ncc is not installed and cannot be installed, TypeScript config is incompatible), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "qa-agent-action-ledger-logger",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message>",
      "filesChanged": [
        ".github/actions/tlm-qa-agent/src/action-ledger.ts",
        ".github/actions/tlm-qa-agent/src/index.ts"
      ]
    }
  }'
```