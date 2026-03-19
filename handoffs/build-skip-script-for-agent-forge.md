# Agent Forge -- Build-skip script for agent-forge

## Metadata
- **Branch:** `feat/vercel-ignore-build-script`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** scripts/vercel-ignore-build.sh

## Context

Vercel supports an "Ignored Build Step" setting where you can point to a script that exits 0 to skip a build or exits 1 to proceed. Agent Forge generates and merges a significant volume of PRs that only touch documentation, handoff files, or markdown — none of which affect the deployed application. Without a build-skip script, every merge triggers a full Vercel build unnecessarily.

This task creates `scripts/vercel-ignore-build.sh` — a bash script that Vercel will invoke as the "Ignored Build Step" command. The logic must:

1. Always build on first commit (no HEAD~1)
2. Skip build if commit message contains `[skip ci]` or `[skip vercel]`
3. Skip build if the diff only touches non-application files (docs/, handoffs/, *.md files)
4. Build if any application code is in the diff

**No concurrent work overlap:** The concurrent work item for ADR-011 only touches `docs/adr/ADR-011-vercel-build-machine-optimization.md`. This task only creates `scripts/vercel-ignore-build.sh`. No file overlap.

**Important note on Vercel "Ignored Build Step":** Vercel's convention is inverted from typical CI — exit code **1** means "proceed with build", exit code **0** means "skip build". This is the opposite of standard Unix conventions.

## Requirements

1. File `scripts/vercel-ignore-build.sh` must exist and be executable (`chmod +x`)
2. Script must start with `#!/bin/bash` and use `set -e` defensively (only where appropriate — note: `set -e` should NOT be used globally since we rely on exit codes from subcommands)
3. Script exits 0 (skip) when `$VERCEL_GIT_COMMIT_MESSAGE` or `git log -1 --pretty=%B` contains `[skip ci]` or `[skip vercel]`
4. Script exits 0 (skip) when `git diff --name-only HEAD~1` returns only files under: `docs/`, `handoffs/`, or files matching `*.md` pattern
5. Script exits 1 (build) when any application file appears in the diff: `app/`, `lib/`, `components/`, `styles/`, `public/`, `package.json`, `package-lock.json`, `next.config.*`, `tsconfig.json`, `vercel.json`, `middleware.ts`, `.github/`, `scripts/` (other than this script itself — actually just build if scripts/ changes), `*.ts`, `*.tsx`, `*.js`, `*.mjs`, `*.css`
6. Script exits 1 (build) when `HEAD~1` does not exist (first commit or shallow clone)
7. Script must print descriptive log messages to stderr so Vercel build logs are interpretable
8. The skip logic should be "allowlist" based: skip only if ALL changed files are in the known-safe list; build otherwise (safe default)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/vercel-ignore-build-script
```

### Step 1: Create the scripts directory and script file

```bash
mkdir -p scripts
```

Create `scripts/vercel-ignore-build.sh` with the following content:

```bash
#!/bin/bash
# vercel-ignore-build.sh
#
# Vercel "Ignored Build Step" script.
# Exit 0 → skip build
# Exit 1 → proceed with build
#
# Vercel docs: https://vercel.com/docs/projects/overview#ignored-build-step

# ---------------------------------------------------------------------------
# Helper: log to stderr (visible in Vercel build logs)
# ---------------------------------------------------------------------------
log() {
  echo "[vercel-ignore-build] $*" >&2
}

# ---------------------------------------------------------------------------
# 1. Verify HEAD~1 exists (handle first commit / shallow clone)
# ---------------------------------------------------------------------------
if ! git rev-parse --verify HEAD~1 > /dev/null 2>&1; then
  log "HEAD~1 does not exist (first commit or shallow clone). Proceeding with build."
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Check commit message for skip markers
# ---------------------------------------------------------------------------
# Prefer Vercel's injected env var; fall back to git log
COMMIT_MSG="${VERCEL_GIT_COMMIT_MESSAGE:-$(git log -1 --pretty=%B 2>/dev/null || echo '')}"

if echo "$COMMIT_MSG" | grep -qE '\[(skip ci|skip vercel)\]'; then
  log "Commit message contains skip marker. Skipping build."
  log "Message: $COMMIT_MSG"
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Get changed files
# ---------------------------------------------------------------------------
CHANGED_FILES=$(git diff --name-only HEAD~1 2>/dev/null)

if [ -z "$CHANGED_FILES" ]; then
  log "No changed files detected. Skipping build."
  exit 0
fi

log "Changed files:"
echo "$CHANGED_FILES" | while read -r f; do log "  $f"; done

# ---------------------------------------------------------------------------
# 4. Check if ALL changed files are in the safe (non-application) list
#    Safe paths: docs/, handoffs/, *.md files at any depth
#    If any file falls outside the safe list → build
# ---------------------------------------------------------------------------
SHOULD_BUILD=0

while IFS= read -r file; do
  # Skip empty lines
  [ -z "$file" ] && continue

  # Safe: docs/ subtree
  if [[ "$file" == docs/* ]]; then
    log "  SAFE (docs/): $file"
    continue
  fi

  # Safe: handoffs/ subtree
  if [[ "$file" == handoffs/* ]]; then
    log "  SAFE (handoffs/): $file"
    continue
  fi

  # Safe: markdown files anywhere (*.md, *.mdx)
  if [[ "$file" == *.md || "$file" == *.mdx ]]; then
    log "  SAFE (*.md): $file"
    continue
  fi

  # Safe: this script itself
  if [[ "$file" == "scripts/vercel-ignore-build.sh" ]]; then
    log "  SAFE (this script): $file"
    continue
  fi

  # Everything else → application code, must build
  log "  BUILD TRIGGER: $file"
  SHOULD_BUILD=1

done <<< "$CHANGED_FILES"

# ---------------------------------------------------------------------------
# 5. Decision
# ---------------------------------------------------------------------------
if [ "$SHOULD_BUILD" -eq 1 ]; then
  log "Application code changed. Proceeding with build."
  exit 1
else
  log "Only non-application files changed. Skipping build."
  exit 0
fi
```

### Step 2: Make the script executable

```bash
chmod +x scripts/vercel-ignore-build.sh
```

### Step 3: Verify the script syntax and basic behavior locally

```bash
# Check for bash syntax errors
bash -n scripts/vercel-ignore-build.sh && echo "Syntax OK"

# Test: simulate skip-ci commit message
VERCEL_GIT_COMMIT_MESSAGE="chore: update docs [skip ci]" bash scripts/vercel-ignore-build.sh
echo "Exit code (expected 0 for skip): $?"

# Test: simulate skip-vercel commit message
VERCEL_GIT_COMMIT_MESSAGE="docs: update readme [skip vercel]" bash scripts/vercel-ignore-build.sh
echo "Exit code (expected 0 for skip): $?"
```

Note: The full diff-based tests will only work correctly in a git repo with history. The syntax check and env-var skip tests are sufficient for CI verification.

### Step 4: Add a brief README note (optional but good practice)

No separate README update is needed — the script is self-documenting. However, verify the `scripts/` directory doesn't already have a README that should be updated:

```bash
ls scripts/ 2>/dev/null || echo "scripts/ directory is new"
```

### Step 5: Verification

```bash
# Syntax check
bash -n scripts/vercel-ignore-build.sh && echo "Syntax OK"

# Confirm executable bit
ls -la scripts/vercel-ignore-build.sh

# TypeScript/build checks (no TS changes in this PR, but run for safety)
npx tsc --noEmit 2>/dev/null || echo "Note: tsc errors are pre-existing, not introduced by this PR"
```

### Step 6: Commit, push, open PR

```bash
git add scripts/vercel-ignore-build.sh
git commit -m "feat: add Vercel build-skip script for docs-only changes"
git push origin feat/vercel-ignore-build-script
gh pr create \
  --title "feat: add Vercel build-skip script for docs-only changes" \
  --body "## Summary

Adds \`scripts/vercel-ignore-build.sh\` — a Vercel 'Ignored Build Step' script that skips builds when only non-application files change.

## Logic

1. **First commit / shallow clone**: Always build (exit 1) — safe default
2. **\`[skip ci]\` or \`[skip vercel]\` in commit message**: Skip build (exit 0)
3. **Only \`docs/\`, \`handoffs/\`, or \`*.md\` files changed**: Skip build (exit 0)
4. **Any other file changed**: Proceed with build (exit 1)

## Motivation

Agent Forge merges many PRs that only touch handoff files, ADRs, or documentation. Without this script, every merge triggers a full Vercel build. This reduces unnecessary build minutes.

## Setup Required

After merging, configure Vercel 'Ignored Build Step' to run:
\`\`\`
bash scripts/vercel-ignore-build.sh
\`\`\`

## Testing

- Syntax validated with \`bash -n\`
- Script is executable (\`chmod +x\`)
- Logic reviewed against Vercel docs (exit 0 = skip, exit 1 = build)

## Files Changed
- \`scripts/vercel-ignore-build.sh\` (new file)
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
BRANCH: feat/vercel-ignore-build-script
FILES CHANGED: scripts/vercel-ignore-build.sh
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains — e.g., "make executable", "verify syntax", "open PR"]
```

## Post-Merge Action Required

This script only works once configured in Vercel. After the PR merges, a human must:

1. Go to Vercel project settings → Git → "Ignored Build Step"
2. Set the command to: `bash scripts/vercel-ignore-build.sh`
3. Save

This is a one-time manual step per Vercel project. The script itself is fully automated once configured.