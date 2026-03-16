# Agent Forge -- Add Notion API Upload to Context Snapshot Script

## Metadata
- **Branch:** `feat/notion-upload-context-snapshot`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** scripts/generate-context-snapshot.sh

## Context

The `scripts/generate-context-snapshot.sh` script already generates a markdown context snapshot of the agent-forge repo (CLAUDE.md, system map, ADRs, recent PRs, etc.). Currently it writes the output to a file or stdout but does not push it anywhere persistent.

This task extends the script to optionally upload the generated markdown to a Notion page via the Notion API. When `NOTION_API_KEY` and `NOTION_CONTEXT_PAGE_ID` are set, the script clears the existing page content and replaces it with the new snapshot. When those env vars are absent, the script falls back gracefully (prints markdown, exits 0).

Key constraints from the Notion API:
- `PATCH /v1/blocks/{page_id}/children` to append blocks (max 100 per call)
- `GET /v1/blocks/{page_id}/children` to list existing children
- `DELETE /v1/blocks/{block_id}` to remove individual blocks
- Notion-Version header: `2022-06-28`
- Blocks must be structured JSON (not raw markdown); use `heading_2` for `## ...` lines, `paragraph` for everything else
- `jq` is used to construct JSON payloads

The script should degrade gracefully on API errors — log to stderr but exit 0.

## Requirements

1. If `NOTION_API_KEY` or `NOTION_CONTEXT_PAGE_ID` are not set, print the markdown to stdout and print a message like `"Notion env vars not set, skipping upload"` to stdout, then exit 0.
2. If both env vars are set, fetch existing child blocks from the Notion page via `GET /v1/blocks/{NOTION_CONTEXT_PAGE_ID}/children` using `curl -s`.
3. Delete each existing child block via `DELETE /v1/blocks/{block_id}` (iterate over the `results` array from step 2).
4. Convert the assembled markdown into Notion block objects: lines starting with `## ` become `heading_2` blocks; all other non-empty lines and paragraph groups become `paragraph` blocks with `rich_text` content. Empty lines are skipped (used only as separators).
5. Batch the resulting block array into groups of at most 100 and append each batch via `POST /v1/blocks/{NOTION_CONTEXT_PAGE_ID}/children` (note: use `PATCH` per Notion docs — use whichever the Notion API actually accepts for appending; standard is `PATCH /v1/blocks/{id}/children`).
6. Handle HTTP errors: if any curl call returns a non-2xx status, log the error body to stderr but continue (do not exit non-zero).
7. The script must require `jq` to be available; if `jq` is not found, print a warning and skip the upload.
8. All existing behavior of `scripts/generate-context-snapshot.sh` (generating the markdown) must be preserved unchanged.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/notion-upload-context-snapshot
```

### Step 1: Inspect the existing script

Read `scripts/generate-context-snapshot.sh` in full to understand:
- How the markdown is assembled (variable name holding the full content, or written to a file)
- The current exit path / output mechanism
- Any existing env var checks

```bash
cat scripts/generate-context-snapshot.sh
```

### Step 2: Add the Notion upload section

Append the following logic **after** the markdown has been fully assembled but **before** any final `exit 0`. The exact insertion point depends on what Step 1 reveals, but the structure to add is:

```bash
# ── Notion Upload ─────────────────────────────────────────────────────────────

# Determine the assembled markdown content.
# If the script writes to a file, read it; if it's in a variable, use that.
# Adjust SNAPSHOT_CONTENT assignment below to match actual script structure.

upload_to_notion() {
  local content="$1"

  # Check for jq
  if ! command -v jq &>/dev/null; then
    echo "Warning: jq not found, skipping Notion upload" >&2
    return 0
  fi

  # Check env vars
  if [[ -z "${NOTION_API_KEY:-}" || -z "${NOTION_CONTEXT_PAGE_ID:-}" ]]; then
    echo "$content"
    echo "Notion env vars not set, skipping upload"
    return 0
  fi

  local PAGE_ID="$NOTION_CONTEXT_PAGE_ID"
  local AUTH_HEADER="Authorization: Bearer $NOTION_API_KEY"
  local VERSION_HEADER="Notion-Version: 2022-06-28"
  local CONTENT_HEADER="Content-Type: application/json"
  local API_BASE="https://api.notion.com/v1"

  echo "Fetching existing child blocks from Notion page ${PAGE_ID}..." >&2

  # 1. GET existing children (handle pagination with has_more if needed — single page sufficient for most snapshots)
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
  # Strategy:
  #   - Lines starting with "## " → heading_2 block
  #   - Non-empty lines            → paragraph block
  #   - Empty lines                → skip
  # We accumulate blocks into a temp file as a JSON array.

  local blocks_file
  blocks_file=$(mktemp)
  echo "[]" > "$blocks_file"

  while IFS= read -r line; do
    local block_json

    if [[ "$line" =~ ^##[[:space:]](.+)$ ]]; then
      # heading_2 block — strip leading "## "
      local heading_text="${BASH_REMATCH[1]}"
      # Truncate to 2000 chars (Notion rich_text limit)
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
# IMPORTANT: Replace SNAPSHOT_CONTENT below with the actual variable or file read
# that holds the final markdown output, as determined by inspecting the script.
upload_to_notion "${SNAPSHOT_CONTENT}"
```

**Integration note:** The exact variable name for the assembled markdown must be confirmed in Step 1. Common patterns:
- If the script ends with `echo "$OUTPUT"` or `echo "$SNAPSHOT"` — pass that variable to `upload_to_notion`
- If it writes to a file (e.g., `context-snapshot.md`) — read the file: `upload_to_notion "$(cat context-snapshot.md)"`

After adding this section, adjust the final output line of the existing script so it still writes to its normal output destination (file / stdout) but also calls `upload_to_notion`.

### Step 3: Make the script executable and test locally (no Notion creds)

```bash
chmod +x scripts/generate-context-snapshot.sh

# Test without Notion env vars — should print markdown + skip message, exit 0
bash scripts/generate-context-snapshot.sh
echo "Exit code: $?"

# Test that jq-missing path doesn't break things (optional if jq is present)
```

### Step 4: Verify script syntax

```bash
bash -n scripts/generate-context-snapshot.sh
echo "Syntax OK: $?"
```

### Step 5: Verification

```bash
# TypeScript / build checks (script is bash, not TS, but run standard checks)
npx tsc --noEmit
npm run build 2>&1 | tail -20

# Confirm the script is valid bash
bash -n scripts/generate-context-snapshot.sh

# Dry-run the script (no Notion vars set = graceful skip)
bash scripts/generate-context-snapshot.sh
echo "Exit: $?"
```

### Step 6: Commit, push, open PR

```bash
git add scripts/generate-context-snapshot.sh
git commit -m "feat: add Notion API upload to context snapshot script

- Adds upload_to_notion() function at end of generate-context-snapshot.sh
- Checks for NOTION_API_KEY and NOTION_CONTEXT_PAGE_ID; skips gracefully if absent
- Deletes existing page children before appending new blocks
- Converts markdown lines to heading_2 / paragraph Notion blocks
- Batches appends in groups of 100 (Notion API limit)
- API errors logged to stderr; script exits 0 on degradation"

git push origin feat/notion-upload-context-snapshot

gh pr create \
  --title "feat: add Notion API upload to context snapshot script" \
  --body "## Summary

Extends \`scripts/generate-context-snapshot.sh\` to upload the generated markdown context snapshot to a Notion page via the Notion API.

## Changes
- Added \`upload_to_notion()\` function at the end of the snapshot script
- Graceful skip when \`NOTION_API_KEY\` / \`NOTION_CONTEXT_PAGE_ID\` are not set (prints markdown + message, exits 0)
- Full page replacement: fetches and deletes existing child blocks before appending
- Converts markdown to Notion block format: \`## ...\` → \`heading_2\`, other lines → \`paragraph\`
- Batches append calls in groups of 100 to respect Notion API limit
- API errors logged to stderr; does not cause non-zero exit (graceful degradation)
- Requires \`jq\`; warns and skips upload if not available

## Testing
- Verified syntax with \`bash -n\`
- Verified graceful skip when env vars are absent
- TypeScript build passes (\`npx tsc --noEmit\`)" \
  --base main
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles/runs
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/notion-upload-context-snapshot
FILES CHANGED: scripts/generate-context-snapshot.sh
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```