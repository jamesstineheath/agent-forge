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
