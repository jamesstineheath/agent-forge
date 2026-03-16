#!/usr/bin/env bash
# generate-context-snapshot.sh
# Generates a structured markdown snapshot of the agent-forge codebase.
# Outputs to stdout. Each section degrades gracefully if tools are missing.
# Usage: ./scripts/generate-context-snapshot.sh
# Usage: ./scripts/generate-context-snapshot.sh > snapshot.md

# Exit on unset variables, but NOT on individual command failures.
# Each section handles its own errors with || patterns.
set -uo pipefail

# Resolve repo root (directory containing this script's parent)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

# ────────────────────────────────────────────────────────────
# Header
# ────────────────────────────────────────────────────────────
echo "# Agent Forge -- Codebase Context Snapshot"
echo ""
echo "_Generated at: $(date -u '+%Y-%m-%dT%H:%M:%SZ')_"
echo ""

# ────────────────────────────────────────────────────────────
## Section 1: Directory Tree
# ────────────────────────────────────────────────────────────
echo "## Directory Tree"
echo ""
if command -v tree >/dev/null 2>&1; then
  tree -L 3 -I 'node_modules|.next|dist|.git|data' 2>/dev/null || echo "_tree command failed_"
else
  echo "_Skipped: \`tree\` is not installed_"
fi
echo ""

# ────────────────────────────────────────────────────────────
## Section 2: Key Interfaces and Types
# ────────────────────────────────────────────────────────────
echo "## Key Interfaces and Types"
echo ""
echo "\`\`\`typescript"

# Search lib/types.ts first
if [ -f "lib/types.ts" ]; then
  echo "### lib/types.ts"
  grep -E '^\s*(export\s+)?(interface|type|enum)\s+' lib/types.ts 2>/dev/null || true
  echo ""
fi

# Search any *.d.ts files outside node_modules
DTS_FILES=$(find . -name "*.d.ts" \
  -not -path "*/node_modules/*" \
  -not -path "*/.next/*" \
  -not -path "*/dist/*" \
  -not -path "*/.git/*" \
  2>/dev/null | sort)

if [ -n "${DTS_FILES}" ]; then
  while IFS= read -r dts_file; do
    MATCHES=$(grep -E '^\s*(export\s+)?(interface|type|enum)\s+' "${dts_file}" 2>/dev/null || true)
    if [ -n "${MATCHES}" ]; then
      echo "### ${dts_file}"
      echo "${MATCHES}"
      echo ""
    fi
  done <<< "${DTS_FILES}"
fi

echo "\`\`\`"
echo ""

# ────────────────────────────────────────────────────────────
## Section 3: Module Import Graph
# ────────────────────────────────────────────────────────────
echo "## Module Import Graph"
echo ""
echo "_Relative imports between lib/ modules:_"
echo ""

LIB_FILES=$(find lib -maxdepth 1 -name "*.ts" -not -name "*.d.ts" 2>/dev/null | sort)

if [ -n "${LIB_FILES}" ]; then
  while IFS= read -r lib_file; do
    # Extract relative imports from this file that reference other lib/ modules
    # Matches: import ... from './something' or import ... from '../lib/something'
    IMPORTS=$(grep -E "^import .* from ['\"]\./" "${lib_file}" 2>/dev/null \
      | grep -oE "from ['\"][^'\"]+['\"]" \
      | sed "s/from ['\"]//;s/['\"]$//" \
      | sed "s|^\./|lib/|" \
      | sed "s|\.ts$||" \
      | sort -u 2>/dev/null || true)

    if [ -n "${IMPORTS}" ]; then
      echo "**${lib_file}** imports:"
      while IFS= read -r imp; do
        echo "  - ${imp}"
      done <<< "${IMPORTS}"
      echo ""
    fi
  done <<< "${LIB_FILES}"
else
  echo "_No lib/*.ts files found_"
  echo ""
fi

# ────────────────────────────────────────────────────────────
## Section 4: Environment Variables
# ────────────────────────────────────────────────────────────
echo "## Environment Variables"
echo ""

ENV_FILE=""
if [ -f ".env.example" ]; then
  ENV_FILE=".env.example"
elif [ -f ".env.local.example" ]; then
  ENV_FILE=".env.local.example"
fi

if [ -n "${ENV_FILE}" ]; then
  echo "_Source: \`${ENV_FILE}\`_"
  echo ""
  echo "\`\`\`"
  # Output only variable names (lines matching VAR_NAME= pattern, strip comments and empty lines)
  grep -E '^[A-Z_][A-Z0-9_]*=' "${ENV_FILE}" 2>/dev/null \
    | sed 's/=.*//' \
    || echo "_No variable definitions found in ${ENV_FILE}_"
  echo "\`\`\`"
else
  echo "_Skipped: Neither \`.env.example\` nor \`.env.local.example\` found_"
fi
echo ""

# ────────────────────────────────────────────────────────────
## Section 5: CLAUDE.md Contents
# ────────────────────────────────────────────────────────────
echo "## CLAUDE.md Contents"
echo ""
if [ -f "CLAUDE.md" ]; then
  cat CLAUDE.md 2>/dev/null || echo "_Failed to read CLAUDE.md_"
else
  echo "_Skipped: \`CLAUDE.md\` not found_"
fi
echo ""

# ────────────────────────────────────────────────────────────
## Section 6: SYSTEM_MAP.md Contents
# ────────────────────────────────────────────────────────────
echo "## SYSTEM_MAP.md Contents"
echo ""
if [ -f "docs/SYSTEM_MAP.md" ]; then
  cat docs/SYSTEM_MAP.md 2>/dev/null || echo "_Failed to read docs/SYSTEM_MAP.md_"
else
  echo "_Skipped: \`docs/SYSTEM_MAP.md\` not found_"
fi
echo ""

# ────────────────────────────────────────────────────────────
## Section 7: Package Scripts
# ────────────────────────────────────────────────────────────
echo "## Package Scripts"
echo ""
if [ ! -f "package.json" ]; then
  echo "_Skipped: \`package.json\` not found_"
elif command -v jq >/dev/null 2>&1; then
  echo "\`\`\`json"
  jq '.scripts' package.json 2>/dev/null || echo "_jq failed to parse package.json_"
  echo "\`\`\`"
else
  echo "_Skipped: \`jq\` is not installed_"
fi
echo ""

# ────────────────────────────────────────────────────────────
## Section 8: Recent Merged PRs
# ────────────────────────────────────────────────────────────
echo "## Recent Merged PRs"
echo ""
if command -v gh >/dev/null 2>&1; then
  PR_OUTPUT=$(gh pr list \
    --state merged \
    --limit 10 \
    --json number,title,changedFiles,mergedAt \
    2>/dev/null || true)

  if [ -n "${PR_OUTPUT}" ] && [ "${PR_OUTPUT}" != "[]" ] && [ "${PR_OUTPUT}" != "null" ]; then
    echo "\`\`\`json"
    echo "${PR_OUTPUT}"
    echo "\`\`\`"
  else
    echo "_Skipped: \`gh pr list\` returned no results or failed (check \`gh auth status\`)_"
  fi
else
  echo "_Skipped: \`gh\` (GitHub CLI) is not installed_"
fi
echo ""

# ────────────────────────────────────────────────────────────
# Footer
# ────────────────────────────────────────────────────────────
echo "---"
echo ""
echo "_End of context snapshot_"

exit 0
