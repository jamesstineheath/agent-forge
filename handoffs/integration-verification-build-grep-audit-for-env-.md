```markdown
# Agent Forge -- Integration verification: build + grep audit for env var cleanup

## Metadata
- **Branch:** `feat/env-var-cleanup-verification`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/api-auth.ts, scripts/test-escalation-e2e.ts, scripts/test-escalation-auth.ts

## Context

A previous refactor renamed `ESCALATION_SECRET` to `AGENT_FORGE_API_SECRET` across the codebase. The rename has been applied to the main files (confirmed via recent merged PR: "refactor: rename ESCALATION_SECRET to AGENT_FORGE_API_SECRET"), but this verification pass ensures no orphaned references remain anywhere — including comments, string literals, documentation, YAML workflows, and test scripts.

This is a confirm-and-fix task. The primary work is auditing and patching any stragglers; no new files should be created.

Key files from the rename:
- `lib/api-auth.ts` — Bearer token validation, must read `process.env.AGENT_FORGE_API_SECRET`
- `app/api/escalations/route.ts` — escalation API handler
- `app/api/work-items/route.ts` — work items API handler
- `scripts/test-escalation-e2e.ts` — E2E test script
- `scripts/test-escalation-auth.ts` — auth test script
- `CLAUDE.md` — documentation
- `.github/workflows/*.yml` — GitHub Actions workflows

## Requirements

1. `grep -rn ESCALATION_SECRET` across all tracked file types returns exactly zero results
2. `npx tsc --noEmit` (and `next build` if feasible) completes without errors
3. `lib/api-auth.ts` (or equivalent) reads from `process.env.AGENT_FORGE_API_SECRET`, not `ESCALATION_SECRET`
4. All scripts in `scripts/` that previously referenced `ESCALATION_SECRET` now reference `AGENT_FORGE_API_SECRET`
5. No orphaned references to `ESCALATION_SECRET` in comments, string literals, or documentation

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/env-var-cleanup-verification
```

### Step 1: Run the grep audit

Run the full audit to find any remaining `ESCALATION_SECRET` references:

```bash
grep -rn ESCALATION_SECRET . \
  --include='*.ts' \
  --include='*.tsx' \
  --include='*.js' \
  --include='*.jsx' \
  --include='*.md' \
  --include='*.yml' \
  --include='*.yaml' \
  --include='*.json' \
  --include='*.env*' \
  --exclude-dir=node_modules \
  --exclude-dir=.next \
  --exclude-dir=dist \
  --exclude-dir=.git
```

Capture the output. If any results are returned, proceed to Step 2 to fix them. If zero results, skip to Step 3.

### Step 2: Fix any remaining ESCALATION_SECRET references

For each file returned by the grep audit, replace `ESCALATION_SECRET` with `AGENT_FORGE_API_SECRET`.

**Systematic replacement command** (safe — only runs if matches exist):

```bash
# Replace in TypeScript/JavaScript files
find . \
  -not -path '*/node_modules/*' \
  -not -path '*/.next/*' \
  -not -path '*/dist/*' \
  -not -path '*/.git/*' \
  \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \) \
  -exec sed -i 's/ESCALATION_SECRET/AGENT_FORGE_API_SECRET/g' {} +

# Replace in markdown files
find . \
  -not -path '*/node_modules/*' \
  -not -path '*/.next/*' \
  -not -path '*/dist/*' \
  -not -path '*/.git/*' \
  \( -name '*.md' \) \
  -exec sed -i 's/ESCALATION_SECRET/AGENT_FORGE_API_SECRET/g' {} +

# Replace in YAML/workflow files
find . \
  -not -path '*/node_modules/*' \
  -not -path '*/.next/*' \
  -not -path '*/dist/*' \
  -not -path '*/.git/*' \
  \( -name '*.yml' -o -name '*.yaml' \) \
  -exec sed -i 's/ESCALATION_SECRET/AGENT_FORGE_API_SECRET/g' {} +

# Replace in JSON files
find . \
  -not -path '*/node_modules/*' \
  -not -path '*/.next/*' \
  -not -path '*/dist/*' \
  -not -path '*/.git/*' \
  \( -name '*.json' \) \
  -exec sed -i 's/ESCALATION_SECRET/AGENT_FORGE_API_SECRET/g' {} +

# Replace in .env files
find . \
  -not -path '*/node_modules/*' \
  -not -path '*/.next/*' \
  -not -path '*/dist/*' \
  -not -path '*/.git/*' \
  \( -name '.env*' \) \
  -exec sed -i 's/ESCALATION_SECRET/AGENT_FORGE_API_SECRET/g' {} +
```

**Note on macOS vs Linux sed:** If running on macOS, `sed -i` requires an empty string argument: `sed -i '' 's/ESCALATION_SECRET/AGENT_FORGE_API_SECRET/g'`. Adjust as needed based on the execution environment.

### Step 3: Verify lib/api-auth.ts explicitly

Manually confirm the auth module is correct:

```bash
cat lib/api-auth.ts
```

It should contain `process.env.AGENT_FORGE_API_SECRET` and **not** `ESCALATION_SECRET`. The expected pattern looks like:

```typescript
const secret = process.env.AGENT_FORGE_API_SECRET;
```

If the file still uses `ESCALATION_SECRET`, patch it directly.

### Step 4: Verify scripts directory

Check the two primary test scripts:

```bash
cat scripts/test-escalation-e2e.ts 2>/dev/null || echo "File not found"
cat scripts/test-escalation-auth.ts 2>/dev/null || echo "File not found"
```

Each should reference `AGENT_FORGE_API_SECRET`. Look for patterns like:

```typescript
const secret = process.env.AGENT_FORGE_API_SECRET;
// or
Authorization: `Bearer ${process.env.AGENT_FORGE_API_SECRET}`
```

If any script still references `ESCALATION_SECRET`, apply targeted fixes.

### Step 5: Run the grep audit again to confirm zero results

```bash
grep -rn ESCALATION_SECRET . \
  --include='*.ts' \
  --include='*.tsx' \
  --include='*.js' \
  --include='*.jsx' \
  --include='*.md' \
  --include='*.yml' \
  --include='*.yaml' \
  --include='*.json' \
  --include='*.env*' \
  --exclude-dir=node_modules \
  --exclude-dir=.next \
  --exclude-dir=dist \
  --exclude-dir=.git
```

**Expected output:** no output / exit code 1 (no matches). If any results still appear, fix them before continuing.

### Step 6: TypeScript check and build

```bash
npx tsc --noEmit
```

If the project has a build script:

```bash
npm run build 2>&1 | tail -30
```

Both should complete without errors. If there are TypeScript errors unrelated to this rename (pre-existing issues), note them in the PR description but do not block the commit on them.

### Step 7: Verification summary — record findings

Before committing, generate a brief audit summary to include in the PR body:

```bash
echo "=== Post-fix audit ==="
echo "ESCALATION_SECRET remaining references:"
grep -rn ESCALATION_SECRET . \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
  --include='*.md' --include='*.yml' --include='*.yaml' \
  --include='*.json' --include='*.env*' \
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist --exclude-dir=.git \
  || echo "✅ Zero results — clean"

echo ""
echo "AGENT_FORGE_API_SECRET references in lib/api-auth.ts:"
grep -n AGENT_FORGE_API_SECRET lib/api-auth.ts || echo "⚠️  Not found in lib/api-auth.ts"

echo ""
echo "AGENT_FORGE_API_SECRET references in scripts/:"
grep -rn AGENT_FORGE_API_SECRET scripts/ || echo "⚠️  Not found in scripts/"
```

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "fix: confirm ESCALATION_SECRET → AGENT_FORGE_API_SECRET rename is complete

- Ran full grep audit across *.ts, *.tsx, *.js, *.jsx, *.md, *.yml, *.yaml, *.json, .env*
- Fixed any remaining orphaned ESCALATION_SECRET references
- Verified lib/api-auth.ts reads process.env.AGENT_FORGE_API_SECRET
- Verified scripts/test-escalation-*.ts reference AGENT_FORGE_API_SECRET
- Confirmed tsc --noEmit passes
- Zero ESCALATION_SECRET references remain in tracked files"

git push origin feat/env-var-cleanup-verification

gh pr create \
  --title "fix: env var cleanup verification — zero ESCALATION_SECRET references confirmed" \
  --body "## Summary

Verification and fix pass confirming the \`ESCALATION_SECRET\` → \`AGENT_FORGE_API_SECRET\` rename is complete across the entire codebase.

## Audit Results

- **grep audit**: Zero \`ESCALATION_SECRET\` references remaining across all tracked file types
- **lib/api-auth.ts**: Confirmed reads from \`process.env.AGENT_FORGE_API_SECRET\`
- **scripts/**: All test scripts updated to reference \`AGENT_FORGE_API_SECRET\`
- **Build**: \`tsc --noEmit\` passes without errors

## Files Changed

Only files with residual \`ESCALATION_SECRET\` references (if any were found); otherwise no changes.

## Verification Commands

\`\`\`bash
grep -rn ESCALATION_SECRET . --include='*.ts' --include='*.tsx' --include='*.md' --include='*.yml' --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist
# Expected: no output
\`\`\`
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
BRANCH: feat/env-var-cleanup-verification
FILES CHANGED: [list any files modified]
SUMMARY: [what was audited and fixed]
ISSUES: [what failed or remains unclear]
NEXT STEPS: [grep results that need manual review, build errors to investigate]
```
```