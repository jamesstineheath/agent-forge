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

# Capture all output to a temp file so we can both print it and upload it
_SNAP_TMP=$(mktemp)
trap 'rm -f "$_SNAP_TMP"' EXIT
exec 3>&1              # save original stdout
exec 1>"$_SNAP_TMP"   # redirect stdout to temp file

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

# ── Restore stdout and output the snapshot ───────────────────────────────────
exec 1>&3 3>&-         # restore original stdout
cat "$_SNAP_TMP"       # write snapshot to original stdout

# ── Notion Upload ─────────────────────────────────────────────────────────────

upload_to_notion() {
  local content="$1"

  # Check for jq
  if ! command -v jq &>/dev/null; then
    echo "Warning: jq not found, skipping Notion upload" >&2
    return 0
  fi

  # Check env vars
  if [[ -z "${NOTION_API_KEY:-}" || -z "${NOTION_CONTEXT_PAGE_ID:-}" ]]; then
    echo "Notion env vars not set, skipping upload"
    return 0
  fi

  local PAGE_ID="$NOTION_CONTEXT_PAGE_ID"
  local AUTH_HEADER="Authorization: Bearer $NOTION_API_KEY"
  local VERSION_HEADER="Notion-Version: 2022-06-28"
  local CONTENT_HEADER="Content-Type: application/json"
  local API_BASE="https://api.notion.com/v1"

  echo "Fetching existing child blocks from Notion page ${PAGE_ID}..." >&2

  # 1. GET existing children
  local children_response
  children_response=$(curl -s -w "\n%{http_code}" \
    -H "$AUTH_HEADER" \
    -H "$VERSION_HEADER" \
    "${API_BASE}/blocks/${PAGE_ID}/children?page_size=100")

  local children_body children_status
  children_status=$(echo "$children_response" | tail -n1)
  children_body=$(echo "$children_response" | sed '$d')

  if [[ "$children_status" != "200" ]]; then
    echo "Error fetching Notion children (HTTP $children_status): $children_body" >&2
    return 0
  fi

  # 2. Delete each existing child block
  local block_ids
  block_ids=$(echo "$children_body" | jq -r '.results[].id // empty')

  if [[ -n "$block_ids" ]]; then
    echo "Deleting existing blocks..." >&2
    while IFS= read -r block_id; do
      local del_status
      del_status=$(curl -s -o /dev/null -w "%{http_code}" \
        -X DELETE \
        -H "$AUTH_HEADER" \
        -H "$VERSION_HEADER" \
        "${API_BASE}/blocks/${block_id}")
      if [[ "$del_status" != "200" ]]; then
        echo "Warning: failed to delete block ${block_id} (HTTP $del_status)" >&2
      fi
    done <<< "$block_ids"
  fi

  # 3. Convert markdown to Notion block JSON array
  local blocks_file
  blocks_file=$(mktemp)
  echo "[]" > "$blocks_file"

  while IFS= read -r line; do
    local block_json

    if [[ "$line" =~ ^##[[:space:]](.+)$ ]]; then
      # heading_2 block
      local heading_text="${BASH_REMATCH[1]}"
      heading_text="${heading_text:0:2000}"
      block_json=$(jq -n \
        --arg text "$heading_text" \
        '{type:"heading_2", heading_2:{rich_text:[{type:"text",text:{content:$text}}]}}')
    elif [[ -n "$line" ]]; then
      # paragraph block — split long lines into ≤2000-char chunks
      local remaining="$line"
      while [[ ${#remaining} -gt 0 ]]; do
        local chunk="${remaining:0:2000}"
        remaining="${remaining:2000}"
        block_json=$(jq -n \
          --arg text "$chunk" \
          '{type:"paragraph", paragraph:{rich_text:[{type:"text",text:{content:$text}}]}}')
        local blocks_file_tmp
        blocks_file_tmp=$(mktemp)
        jq --argjson block "$block_json" '. + [$block]' "$blocks_file" > "$blocks_file_tmp"
        mv "$blocks_file_tmp" "$blocks_file"
      done
      continue
    else
      continue
    fi

    local blocks_file_tmp
    blocks_file_tmp=$(mktemp)
    jq --argjson block "$block_json" '. + [$block]' "$blocks_file" > "$blocks_file_tmp"
    mv "$blocks_file_tmp" "$blocks_file"

  done <<< "$content"

  # 4. Batch append in groups of 100
  local total_blocks
  total_blocks=$(jq 'length' "$blocks_file")
  echo "Appending ${total_blocks} blocks to Notion page (batches of 100)..." >&2

  local offset=0
  while [[ $offset -lt $total_blocks ]]; do
    local batch
    batch=$(jq --argjson offset "$offset" '.[$offset:$offset+100]' "$blocks_file")

    local payload
    payload=$(jq -n --argjson children "$batch" '{children: $children}')

    local append_response append_status append_body
    append_response=$(curl -s -w "\n%{http_code}" \
      -X PATCH \
      -H "$AUTH_HEADER" \
      -H "$VERSION_HEADER" \
      -H "$CONTENT_HEADER" \
      -d "$payload" \
      "${API_BASE}/blocks/${PAGE_ID}/children")

    append_status=$(echo "$append_response" | tail -n1)
    append_body=$(echo "$append_response" | sed '$d')

    if [[ "$append_status" != "200" ]]; then
      echo "Error appending blocks at offset ${offset} (HTTP $append_status): $append_body" >&2
    else
      echo "Appended batch at offset ${offset} ($(echo "$batch" | jq 'length') blocks)" >&2
    fi

    offset=$((offset + 100))
  done

  rm -f "$blocks_file"
  echo "Notion upload complete." >&2
}

# Call the upload function with the assembled snapshot content
upload_to_notion "$(cat "$_SNAP_TMP")"

exit 0
