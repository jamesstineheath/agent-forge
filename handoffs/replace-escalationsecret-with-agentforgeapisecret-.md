# Agent Forge -- Replace ESCALATION_SECRET with AGENT_FORGE_API_SECRET

## Metadata
- **Branch:** `feat/rename-escalation-secret`
- **Priority:** high
- **Model:** sonnet
- **Type:** refactor
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/escalation.ts, lib/api-auth.ts, app/api/escalations/route.ts, app/api/work-items/route.ts, scripts/sync-escalation-secrets.ts, scripts/test-escalation-e2e.ts, scripts/test-escalation-auth.ts

## Context

The codebase currently uses `ESCALATION_SECRET` as an environment variable name for Bearer token authentication across API routes and scripts. This is being renamed to `AGENT_FORGE_API_SECRET` for consistency and clarity. The new env var is already set in Vercel with the same value, so this is a pure rename with no functional change.

This is a single atomic rename operation — every string `ESCALATION_SECRET` in source files must become `AGENT_FORGE_API_SECRET`. No logic changes, no new functionality.

Recent PRs show `lib/api-auth.ts` and `app/api/escalations/route.ts` and `app/api/work-items/route.ts` were involved in adding Bearer token auth (feat: add Bearer token auth to work items API), so those are the primary files to update.

## Requirements

1. Every occurrence of `ESCALATION_SECRET` in the repo (excluding `node_modules/`, `.next/`, `dist/`) must be replaced with `AGENT_FORGE_API_SECRET`
2. This includes: TypeScript/JS source, Markdown docs, YAML workflows, JSON files, `.env*.example` files, comments, string literals, and the handoff file itself
3. TypeScript compilation must succeed after the rename (`npx tsc --noEmit`)
4. No functional logic changes — only the string `ESCALATION_SECRET` changes to `AGENT_FORGE_API_SECRET`
5. Post-change grep for `ESCALATION_SECRET` across all source files returns zero results
6. Post-change grep for `AGENT_FORGE_API_SECRET` returns at least as many results as `ESCALATION_SECRET` had before

## Execution Steps

### Step 0: Branch setup

```bash
git checkout main && git pull
git checkout -b feat/rename-escalation-secret
```

### Step 1: Audit — count and record all occurrences before making changes

```bash
echo "=== BEFORE: All ESCALATION_SECRET occurrences ==="
grep -rn "ESCALATION_SECRET" . \
  --exclude-dir=node_modules \
  --exclude-dir=.next \
  --exclude-dir=dist \
  --include="*.ts" \
  --include="*.tsx" \
  --include="*.js" \
  --include="*.md" \
  --include="*.yml" \
  --include="*.yaml" \
  --include="*.json" \
  --include="*.example" \
  --include="*.env*"
```

Record the count. This is the number of replacements that must be made.

### Step 2: Perform the rename across all file types

Use `sed` for a global in-place replacement across all relevant files found by grep:

```bash
# Find all files containing ESCALATION_SECRET (excluding node_modules, .next, dist)
FILES=$(grep -rl "ESCALATION_SECRET" . \
  --exclude-dir=node_modules \
  --exclude-dir=.next \
  --exclude-dir=dist)

echo "Files to update:"
echo "$FILES"

# Replace in all found files
for f in $FILES; do
  sed -i 's/ESCALATION_SECRET/AGENT_FORGE_API_SECRET/g' "$f"
  echo "Updated: $f"
done
```

> **Note:** On macOS, `sed -i` requires an empty string argument: `sed -i '' 's/ESCALATION_SECRET/AGENT_FORGE_API_SECRET/g' "$f"`. Use whichever form works in the execution environment, or use `perl -pi -e` as a portable alternative:
>
> ```bash
> perl -pi -e 's/ESCALATION_SECRET/AGENT_FORGE_API_SECRET/g' $FILES
> ```

### Step 3: Verify — zero ESCALATION_SECRET references remain

```bash
echo "=== AFTER: Remaining ESCALATION_SECRET occurrences (should be zero) ==="
REMAINING=$(grep -rn "ESCALATION_SECRET" . \
  --exclude-dir=node_modules \
  --exclude-dir=.next \
  --exclude-dir=dist \
  --include="*.ts" \
  --include="*.tsx" \
  --include="*.js" \
  --include="*.md" \
  --include="*.yml" \
  --include="*.yaml" \
  --include="*.json" \
  --include="*.example" \
  --include="*.env*")

if [ -n "$REMAINING" ]; then
  echo "ERROR: ESCALATION_SECRET still found in:"
  echo "$REMAINING"
  exit 1
else
  echo "SUCCESS: Zero ESCALATION_SECRET references remain."
fi

echo "=== AFTER: AGENT_FORGE_API_SECRET occurrences ==="
grep -rn "AGENT_FORGE_API_SECRET" . \
  --exclude-dir=node_modules \
  --exclude-dir=.next \
  --exclude-dir=dist \
  --include="*.ts" \
  --include="*.tsx" \
  --include="*.js" \
  --include="*.md" \
  --include="*.yml" \
  --include="*.yaml" \
  --include="*.json" \
  --include="*.example" \
  --include="*.env*"
```

### Step 4: Also check the handoff files directory and any .env files not matched above

```bash
# Catch any remaining files with different extensions or no extension
grep -rn "ESCALATION_SECRET" . \
  --exclude-dir=node_modules \
  --exclude-dir=.next \
  --exclude-dir=dist \
  --exclude-dir=.git

# If any are found, apply the same replacement:
# perl -pi -e 's/ESCALATION_SECRET/AGENT_FORGE_API_SECRET/g' <file>
```

### Step 5: TypeScript compilation check

```bash
npx tsc --noEmit
```

If there are TypeScript errors unrelated to this rename (pre-existing), note them but do not fix them — this PR scope is only the rename. If there are errors directly caused by the rename, investigate and fix.

### Step 6: Optional — verify the app builds

```bash
npm run build 2>&1 | tail -20
```

If the build fails for reasons unrelated to this rename, note it in the PR but do not block.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "refactor: rename ESCALATION_SECRET to AGENT_FORGE_API_SECRET across codebase"
git push origin feat/rename-escalation-secret
gh pr create \
  --title "refactor: rename ESCALATION_SECRET → AGENT_FORGE_API_SECRET" \
  --body "## Summary

Atomic rename of the \`ESCALATION_SECRET\` environment variable to \`AGENT_FORGE_API_SECRET\` across the entire codebase.

## Changes
- Replaced every occurrence of \`ESCALATION_SECRET\` with \`AGENT_FORGE_API_SECRET\` in all source files (TypeScript, Markdown, YAML, JSON, .env examples)
- No functional logic changes — only the env var name string is different

## Files Updated
See diff — all changes are purely string replacements of \`ESCALATION_SECRET\` → \`AGENT_FORGE_API_SECRET\`.

## Verification
- \`grep -rn ESCALATION_SECRET\` (excluding node_modules/.next/dist) returns **zero results** after this change
- TypeScript compilation passes (\`npx tsc --noEmit\`)

## ⚠️ Post-Merge Action Required
After this PR is merged, the \`ESCALATION_SECRET\` environment variable in Vercel can be **safely removed**. \`AGENT_FORGE_API_SECRET\` is already set in Vercel with the same value, so no downtime or secret rotation is needed.
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever has been changed so far
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/rename-escalation-secret
FILES CHANGED: [list files that were updated]
SUMMARY: Partial rename of ESCALATION_SECRET to AGENT_FORGE_API_SECRET. Sed/perl replacement was run but verification step may not have completed.
ISSUES: [describe what failed or was not completed]
NEXT STEPS: Run `grep -rn ESCALATION_SECRET . --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist` to find any remaining references and manually replace them.
```