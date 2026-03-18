#!/usr/bin/env bash
# Vercel Ignored Build Step
# Exit 0 = SKIP build (do NOT deploy)
# Exit 1 = PROCEED with build (DO deploy)
# See: https://vercel.com/docs/projects/overview#ignored-build-step

set -euo pipefail

# If either SHA is missing (e.g. first deploy), proceed with build
if [ -z "${VERCEL_GIT_PREVIOUS_SHA:-}" ] || [ -z "${VERCEL_GIT_COMMIT_SHA:-}" ]; then
  echo "Missing commit SHAs (likely first deploy), proceeding with build"
  exit 1
fi

# Get list of changed files between the two commits
# Vercel uses shallow clones, so VERCEL_GIT_PREVIOUS_SHA may not exist.
# Try to deepen history before falling back to HEAD~1.
CHANGED_FILES=$(git diff --name-only "$VERCEL_GIT_PREVIOUS_SHA" "$VERCEL_GIT_COMMIT_SHA" 2>/dev/null) || {
  echo "Could not diff commits (shallow clone), deepening history..."
  git fetch --deepen=2 2>/dev/null || true
  CHANGED_FILES=$(git diff --name-only HEAD~1 HEAD 2>/dev/null) || {
    echo "Still could not diff, proceeding with build"
    exit 1
  }
}

if [ -z "$CHANGED_FILES" ]; then
  echo "No changed files detected, skipping deploy"
  exit 0
fi

# Check each changed file against ignore patterns
while IFS= read -r file; do
  case "$file" in
    handoffs/*) ;;
    docs/*) ;;
    .github/*) ;;
    *.md)
      # Only ignore root-level markdown files (no slash in path)
      if [[ "$file" != */* ]]; then
        continue
      fi
      # Non-root markdown outside docs/ — this is an app file
      echo "App file changed: $file — proceeding with deploy"
      exit 1
      ;;
    *)
      echo "App file changed: $file — proceeding with deploy"
      exit 1
      ;;
  esac
done <<< "$CHANGED_FILES"

echo "All changes are non-app files, skipping deploy"
exit 0
