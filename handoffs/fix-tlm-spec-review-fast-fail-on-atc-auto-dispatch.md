<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Fix TLM Spec Review Fast-Fail on ATC Auto-Dispatched Branches

## Metadata
- **Branch:** `fix/atc-dispatch-handoff-path`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/atc.ts, lib/github.ts, .github/actions/tlm-spec-review/action.yml

## Context

When ATC auto-dispatches a work item, it creates a branch, commits the handoff file, and triggers `execute-handoff.yml`. The `tlm-spec-review.yml` workflow also fires on the push, but it exits in ~6 seconds — far too fast for any API call — which means the spec review action's auto-detect logic finds no handoff file and exits early.

Evidence:
- Work item `9e38cb57` dispatched at 20:16Z → TLM spec review run `23214450647` failed in ~6s at 20:16Z
- `list_handoff_files` returns Not Found (no `handoffs/awaiting_handoff/` directory on main)
- The `push_handoff` MCP tool defaults to `handoffs/awaiting_handoff` — that's the expected path
- Previous successful TLM spec review runs (e.g., on `fix/retrigger-ci-*`) worked fine because those used `push_handoff` which wrote to the correct path

Root cause: the ATC auto-dispatch code path in `lib/atc.ts` (and possibly `lib/github.ts`) commits the handoff file to `handoffs/<filename>.md` instead of `handoffs/awaiting_handoff/<filename>.md`. The TLM spec review action searches `handoffs/awaiting_handoff/`, finds nothing, and exits immediately.

The fix is a small string change in the dispatch path logic — change the file destination from `handoffs/` to `handoffs/awaiting_handoff/`.

## Requirements

1. The ATC auto-dispatch code path commits handoff files to `handoffs/awaiting_handoff/<filename>.md` on the new branch (not `handoffs/<filename>.md`).
2. The TLM spec review workflow on ATC-dispatched branches finds the handoff file and runs the actual review (runtime > 30 seconds, not ~6 seconds).
3. No change to how `push_handoff` MCP tool or manual dispatch works — they already use the correct path.
4. Existing tests pass (`npx tsc --noEmit` succeeds).
5. The `handoffs/awaiting_handoff/` directory exists in the repo (create a `.gitkeep` if needed so the path is tracked).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/atc-dispatch-handoff-path
```

### Step 1: Audit the current handoff path in ATC dispatch

Read the ATC dispatch logic to find where the handoff file path is constructed:

```bash
grep -n "handoffs" lib/atc.ts
grep -n "handoffs" lib/github.ts
grep -rn "handoffs" lib/orchestrator.ts
```

Look specifically for patterns like:
- `handoffs/${filename}`
- `handoffs/` + filename
- Any variable named `handoffPath`, `filePath`, `path`, etc. that contains `handoffs/`

Also check the TLM spec review action to confirm what directory it searches:

```bash
cat .github/actions/tlm-spec-review/action.yml
# or
ls .github/actions/tlm-spec-review/
cat .github/actions/tlm-spec-review/index.js 2>/dev/null || cat .github/actions/tlm-spec-review/index.ts 2>/dev/null
```

### Step 2: Fix the handoff file path in ATC dispatch

Once you've identified the location(s) where the handoff file path is set in the ATC dispatch code path, change `handoffs/` to `handoffs/awaiting_handoff/`.

**Expected finding in `lib/atc.ts` or `lib/github.ts`** — look for something like:

```typescript
// BEFORE (wrong):
const handoffPath = `handoffs/${filename}.md`;
// or
path: `handoffs/${workItem.id}.md`,

// AFTER (correct):
const handoffPath = `handoffs/awaiting_handoff/${filename}.md`;
// or
path: `handoffs/awaiting_handoff/${workItem.id}.md`,
```

Also check `lib/orchestrator.ts` — it may be involved in constructing the path when generating and pushing handoffs.

Apply the fix wherever the incorrect path is constructed. Use `grep -rn "handoffs/" lib/` to find all occurrences and evaluate each one.

**Do not change** paths that are:
- Already `handoffs/awaiting_handoff/`
- Reading from the handoffs directory (not writing to it)
- In test files with different intentions

### Step 3: Ensure `handoffs/awaiting_handoff/` directory exists in the repo

```bash
mkdir -p handoffs/awaiting_handoff
ls handoffs/awaiting_handoff/.gitkeep 2>/dev/null || touch handoffs/awaiting_handoff/.gitkeep
```

Check if the directory already has contents:
```bash
ls -la handoffs/
ls -la handoffs/awaiting_handoff/ 2>/dev/null
```

If `handoffs/awaiting_handoff/` doesn't exist in the repo, add the `.gitkeep` so it's tracked.

### Step 4: Verify the TLM spec review action's expected path

Confirm the spec review action searches `handoffs/awaiting_handoff/`:

```bash
grep -rn "awaiting_handoff\|handoffs" .github/actions/tlm-spec-review/
```

If the spec review action uses a different path (e.g., just `handoffs/`), update **either** the action **or** the dispatch path so they agree. Prefer updating the dispatch path in `lib/atc.ts` to match `handoffs/awaiting_handoff/` since that's the documented convention from `push_handoff`.

### Step 5: TypeScript check

```bash
npx tsc --noEmit
```

Fix any type errors introduced by the change.

### Step 6: Verify no other dispatch paths are broken

```bash
grep -rn "handoffs/" lib/ app/ --include="*.ts" --include="*.tsx"
```

Review each result to ensure:
- Write paths use `handoffs/awaiting_handoff/`
- Read paths that need to scan `awaiting_handoff/` do so correctly
- Any path that intentionally writes to `handoffs/` root (e.g., archiving completed handoffs) is left alone

### Step 7: Verification

```bash
npx tsc --noEmit
npm run build
```

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "fix: commit handoff files to handoffs/awaiting_handoff/ in ATC dispatch

ATC auto-dispatch was writing handoff files to handoffs/<filename>.md,
but tlm-spec-review action auto-detects files in handoffs/awaiting_handoff/.
When no file was found there, spec review exited in ~6s without reviewing.

Change the dispatch path to handoffs/awaiting_handoff/<filename>.md so
the spec review action finds the file and performs the actual review."

git push origin fix/atc-dispatch-handoff-path

gh pr create \
  --title "fix: commit handoff files to handoffs/awaiting_handoff/ in ATC dispatch" \
  --body "## Problem

When ATC auto-dispatches a work item, the handoff file was being committed to \`handoffs/<filename>.md\`. The TLM spec review action searches \`handoffs/awaiting_handoff/\` for files to review. Finding nothing, it exited in ~6 seconds without performing any review.

Evidence:
- Work item \`9e38cb57\` dispatched at 20:16Z → TLM spec review run \`23214450647\` failed in ~6s
- Manual dispatches via \`push_handoff\` MCP tool (which uses the correct path) worked fine

## Fix

Changed the handoff file destination in ATC auto-dispatch from \`handoffs/<filename>.md\` to \`handoffs/awaiting_handoff/<filename>.md\`.

Also ensured \`handoffs/awaiting_handoff/\` directory exists in the repo.

## Testing

- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- Next ATC dispatch cycle will write to the correct path and TLM spec review will proceed normally

## Risk

Low — single path string change in dispatch logic. No schema changes, no API changes."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: fix/atc-dispatch-handoff-path
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you cannot locate the handoff path construction in `lib/atc.ts`, `lib/github.ts`, or `lib/orchestrator.ts` after thorough grep, escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "fix-tlm-spec-review-fast-fail",
    "reason": "Cannot locate handoff file path construction in ATC dispatch code path. Grepped lib/atc.ts, lib/github.ts, lib/orchestrator.ts for handoffs/ patterns but could not find where the dispatch path is set.",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "2",
      "error": "Path construction not found in expected files",
      "filesChanged": []
    }
  }'
```