# Agent Forge -- Integration test — full retry lifecycle verification

## Metadata
- **Branch:** `feat/retry-lifecycle-integration-test`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/types.ts, lib/notion.ts, lib/projects.ts, lib/atc.ts

## Context

Four changes were independently developed to implement the project retry lifecycle:
1. **lib/types.ts** — Added `project_retry` event type and/or retry-related types
2. **lib/notion.ts** — Added retry-related Notion integration
3. **lib/projects.ts** — Added `retryProject` and related retry wrapper functions
4. **lib/atc.ts** — Added ATC §4 retry processing section

This handoff verifies these four changes are mutually consistent: no type mismatches, no import errors, correct dedup guard key patterns, correct retry cap enforcement, and correct ATC section ordering. If issues are found, they should be fixed in-place.

Key invariants to verify:
- Retry cap constant is `3`, applied with `>= 3` (i.e., `retryCount >= 3` → Failed)
- Dedup guard key for retry must match the pattern used in §4.5: `atc/project-decomposed/{projectId}`
- ATC retry section (§4) appears **before** project decomposition (§4.5) in the cycle loop
- `project_retry` event type is handled by the existing ATCEvent logging mechanism

## Requirements

1. `npx tsc --noEmit` must pass with zero errors
2. `npm run build` must complete successfully with no warnings related to modified files
3. ATC retry processing section must be ordered before the project decomposition section (§4.5) in `lib/atc.ts`
4. Retry cap must be exactly `3`, enforced with `>= 3` comparison (not `> 3`)
5. Dedup guard deletion key pattern must exactly match `atc/project-decomposed/${projectId}` (the same key used when the guard is set in §4.5)
6. `project_retry` event type must be usable with the existing ATCEvent logging mechanism (either as a recognized union member or otherwise compilable)
7. If any of the above invariants are violated, fix them directly in the relevant file(s)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/retry-lifecycle-integration-test
```

### Step 1: Run TypeScript check and capture output

```bash
npx tsc --noEmit 2>&1 | tee /tmp/tsc-output.txt
echo "Exit code: $?"
```

If errors exist, proceed to Step 2 to diagnose and fix. If clean, skip to Step 3.

### Step 2: Fix any TypeScript errors

Review `/tmp/tsc-output.txt`. Common issues to look for:

**Type mismatch in ATCEvent:**
In `lib/types.ts`, find the `ATCEvent` type (or equivalent event union). If `project_retry` is not a member, add it:
```typescript
// Example — find the actual union and add project_retry
export type ATCEventType = 
  | 'project_decomposed'
  | 'work_item_dispatched'
  | 'project_retry'  // Add if missing
  | ... // other existing members
```

**Missing export from lib/projects.ts:**
If `lib/atc.ts` imports a function (e.g., `retryProject`, `resetProjectForRetry`) that doesn't exist or is misnamed in `lib/projects.ts`, align the export name. Do NOT rename the function if it's already used elsewhere — add an alias export instead:
```typescript
// lib/projects.ts — add alias if needed
export { retryProjectInternal as retryProject }
```

**RetryCount field missing from Project type:**
In `lib/types.ts`, find the `Project` interface/type. If `retryCount` is missing:
```typescript
export interface Project {
  // ... existing fields ...
  retryCount?: number  // Add if missing — optional for backwards compat
}
```

**Import path errors:**
If imports in `lib/atc.ts` reference functions from `lib/projects.ts` that don't exist, fix the import to match actual exports. Use:
```bash
grep -n "export" lib/projects.ts | grep -i retry
grep -n "import.*projects" lib/atc.ts
```

### Step 3: Verify ATC section ordering

```bash
grep -n "§4\|§4\.5\|retry\|decompos" lib/atc.ts | head -60
```

The retry processing block must appear **before** the decomposition block (`§4.5`). Look for the section comments. If the retry section (§4) comes after §4.5, move the entire retry block above the decomposition block.

To verify ordering precisely:
```bash
# Get line numbers for retry section start and decomposition section start
RETRY_LINE=$(grep -n "§4[^\.]\|Section 4[^\.]\|retry processing\|project.*retry" lib/atc.ts | grep -v "§4\.5" | head -1 | cut -d: -f1)
DECOMP_LINE=$(grep -n "§4\.5\|Section 4\.5\|decomposit" lib/atc.ts | head -1 | cut -d: -f1)
echo "Retry section line: $RETRY_LINE"
echo "Decomposition section line: $DECOMP_LINE"
if [ "$RETRY_LINE" -lt "$DECOMP_LINE" ]; then
  echo "✓ ORDER CORRECT: retry ($RETRY_LINE) before decomposition ($DECOMP_LINE)"
else
  echo "✗ ORDER WRONG: retry ($RETRY_LINE) is after decomposition ($DECOMP_LINE) — fix needed"
fi
```

If ordering is wrong, locate the retry block boundaries (start/end), cut the block, and paste it before the decomposition block. The blocks should be self-contained `if`/`for` sections.

### Step 4: Verify retry cap is exactly 3 with >= comparison

```bash
grep -n "retryCount\|retry_count\|retryCAP\|RETRY_CAP\|maxRetry\|>= 3\|> 2\|> 3\|>= 4" lib/atc.ts lib/projects.ts
```

Expected: something like `retryCount >= 3` (or equivalent constant). 

- If `> 2` is used instead of `>= 3`, they are equivalent — this is acceptable, no change needed.
- If `> 3` or `>= 4` is used, change to `>= 3`.
- If a named constant is used (e.g., `MAX_RETRIES = 3`), verify the constant value is `3`.

### Step 5: Verify dedup guard key pattern

```bash
# Find where the dedup guard is SET in §4.5 (decomposition section)
grep -n "project-decomposed\|atc/project" lib/atc.ts | head -20
```

The key used when **setting** the guard in §4.5 should be `atc/project-decomposed/${projectId}` (or similar with the projectId interpolated).

```bash
# Find where the dedup guard is DELETED in the retry section
grep -n "delete\|remove\|blob.*atc\|atc.*blob" lib/atc.ts | head -20
```

The key used when **deleting** the guard in the retry section must exactly match the key used when setting it. If they differ (e.g., set as `atc/project-decomposed/${projectId}` but deleted as `atc/project-retry/${projectId}`), fix the delete call to use the correct key:

```typescript
// Correct deletion — must match the key used in §4.5
await storage.delete(`atc/project-decomposed/${projectId}`)
// or whatever the exact pattern is — align to what §4.5 sets
```

### Step 6: Verify project_retry is loggable via ATCEvent

```bash
grep -n "ATCEvent\|logEvent\|project_retry" lib/atc.ts lib/types.ts | head -30
```

Find the event logging call in the retry section. It should look like:
```typescript
await logATCEvent({ type: 'project_retry', projectId, ... })
// or
atcEvents.push({ type: 'project_retry', ... })
```

Check that `project_retry` is a valid value for the event type field. If the type is a string literal union in `lib/types.ts` and `project_retry` is not included, add it to the union. If the type is just `string`, no change needed.

### Step 7: Run full build verification

```bash
npx tsc --noEmit 2>&1
echo "=== TSC exit code: $? ==="
npm run build 2>&1
echo "=== Build exit code: $? ==="
```

Both must succeed (exit code 0). If `npm run build` fails but `tsc --noEmit` passes, look for:
- Missing dynamic imports
- Module resolution issues (check `tsconfig.json` paths)
- Next.js-specific build errors (server component / client component boundary violations)

Address any remaining errors before proceeding.

### Step 8: Verification summary

Run the full check suite and confirm all invariants:

```bash
echo "=== INVARIANT CHECK ==="

echo "1. TypeScript clean:"
npx tsc --noEmit && echo "✓ PASS" || echo "✗ FAIL"

echo "2. Build clean:"
npm run build > /dev/null 2>&1 && echo "✓ PASS" || echo "✗ FAIL"

echo "3. ATC section ordering (retry before decomposition):"
RETRY_LINE=$(grep -n "§4[^\.5]\|retry processing" lib/atc.ts | head -1 | cut -d: -f1)
DECOMP_LINE=$(grep -n "§4\.5\|decomposit" lib/atc.ts | head -1 | cut -d: -f1)
[ "$RETRY_LINE" -lt "$DECOMP_LINE" ] && echo "✓ PASS (retry:$RETRY_LINE < decomp:$DECOMP_LINE)" || echo "✗ FAIL"

echo "4. Retry cap >= 3:"
grep -n "3" lib/atc.ts lib/projects.ts | grep -i "retry" && echo "(verify >= 3 above)"

echo "5. Dedup guard key consistency:"
grep -n "project-decomposed" lib/atc.ts

echo "6. project_retry in ATCEvent type:"
grep -n "project_retry" lib/types.ts lib/atc.ts
```

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "fix: verify and align retry lifecycle integration across types, projects, atc"
git push origin feat/retry-lifecycle-integration-test
gh pr create \
  --title "fix: integration test — full retry lifecycle verification" \
  --body "## Summary

Verified and aligned the full project retry lifecycle across all four independently-developed changes:
- \`lib/types.ts\` — retry types and ATCEvent union
- \`lib/notion.ts\` — retry-related notion integration  
- \`lib/projects.ts\` — retry wrapper functions
- \`lib/atc.ts\` — ATC §4 retry processing section

## Invariants Verified

- [ ] \`npx tsc --noEmit\` passes with zero errors
- [ ] \`npm run build\` completes successfully
- [ ] ATC retry section (§4) positioned before decomposition (§4.5)
- [ ] Retry cap is 3, enforced with \`>= 3\` comparison
- [ ] Dedup guard delete key matches set key (\`atc/project-decomposed/{projectId}\`)
- [ ] \`project_retry\` event type is valid in ATCEvent union

## Changes Made

[List any fixes applied, or 'No changes required — all invariants passed on first check']
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
BRANCH: feat/retry-lifecycle-integration-test
FILES CHANGED: [list]
SUMMARY: [what was verified/fixed]
ISSUES: [what failed or couldn't be resolved]
NEXT STEPS: [what invariants still need checking]
```

If a blocker cannot be resolved autonomously (e.g., the retry architecture is fundamentally broken and requires design decisions), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "retry-lifecycle-integration-test",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/types.ts", "lib/notion.ts", "lib/projects.ts", "lib/atc.ts"]
    }
  }'
```