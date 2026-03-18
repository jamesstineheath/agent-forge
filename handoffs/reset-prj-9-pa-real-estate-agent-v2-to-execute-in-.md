<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Reset PRJ-9 to Execute in Notion for Re-decomposition

## Metadata
- **Branch:** `feat/reset-prj9-execute-notion`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** handoffs/reset-prj9-execute-notion.md (this file only — no source changes)

## Context

PRJ-9 (PA Real Estate Agent v2) is stuck in "Failed" status in Notion after the decomposer threw on a self-referencing dependency (Item 17 depending on itself). The root cause has been fixed in PR #228 (commit 33cd8e29), which updated `lib/decomposer.ts` to warn+filter self-references instead of throwing.

This task is a pure Notion data update — no source code changes required. We need to:
1. Reset the Notion project page status from "Failed" → "Execute"
2. Resolve escalation `esc_1773798905776_nehxrrg8g` if still pending

Once the status is set to "Execute", the ATC's next cycle will detect the project and kick off re-decomposition using the now-fixed decomposer code.

**Key IDs:**
- Notion Projects DB: `b1eb06a469ac4a9eb3f01851611fb80b`
- Project: PRJ-9 (PA Real Estate Agent v2)
- Escalation ID: `esc_1773798905776_nehxrrg8g`
- Agent Forge API: `$AGENT_FORGE_URL/api/escalations`

## Requirements

1. Find the PRJ-9 page in the Notion projects database by querying for pages where the project ID or title matches PRJ-9 / "PA Real Estate Agent v2".
2. Update the Status property of that page from "Failed" to "Execute".
3. Confirm the update was applied by re-fetching the page and logging the current status.
4. If escalation `esc_1773798905776_nehxrrg8g` exists and is in "pending" state, resolve it via the Agent Forge escalations API with a resolution note explaining the fix.
5. No TypeScript source files should be modified.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/reset-prj9-execute-notion
```

### Step 1: Verify environment variables are available
```bash
echo "NOTION_API_KEY set: $([ -n "$NOTION_API_KEY" ] && echo YES || echo NO)"
echo "NOTION_PROJECTS_DB_ID set: $([ -n "$NOTION_PROJECTS_DB_ID" ] && echo YES || echo NO)"
echo "AGENT_FORGE_URL set: $([ -n "$AGENT_FORGE_URL" ] && echo YES || echo NO)"
echo "AGENT_FORGE_API_SECRET set: $([ -n "$AGENT_FORGE_API_SECRET" ] && echo YES || echo NO)"
```

If `NOTION_API_KEY` or `NOTION_PROJECTS_DB_ID` are not set, use the hardcoded DB ID `b1eb06a469ac4a9eb3f01851611fb80b` for the database and escalate if the API key is missing (see Escalation Protocol below).

### Step 2: Query Notion for PRJ-9

Query the projects database to find the PRJ-9 page:

```bash
NOTION_DB_ID="${NOTION_PROJECTS_DB_ID:-b1eb06a469ac4a9eb3f01851611fb80b}"

curl -s -X POST "https://api.notion.com/v1/databases/${NOTION_DB_ID}/query" \
  -H "Authorization: Bearer ${NOTION_API_KEY}" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{
    "filter": {
      "or": [
        {
          "property": "Name",
          "title": {
            "contains": "PRJ-9"
          }
        },
        {
          "property": "Name",
          "title": {
            "contains": "PA Real Estate Agent v2"
          }
        },
        {
          "property": "Name",
          "title": {
            "contains": "Real Estate"
          }
        }
      ]
    }
  }' | tee /tmp/prj9_query_result.json | python3 -m json.tool
```

Inspect the output and note the `id` field of the matching result. This is the Notion page ID for PRJ-9.

```bash
# Extract the page ID
PRJ9_PAGE_ID=$(cat /tmp/prj9_query_result.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
results = data.get('results', [])
if not results:
    print('ERROR: No results found')
    sys.exit(1)
for r in results:
    title_parts = r.get('properties', {}).get('Name', {}).get('title', [])
    title = ''.join(t.get('plain_text', '') for t in title_parts)
    print(f'Found: {title} -> {r[\"id\"]}')
# Use first result
print(results[0]['id'])
" | tail -1)

echo "PRJ-9 page ID: ${PRJ9_PAGE_ID}"
```

If the filter above returns no results, try a broader query (no filter) and inspect all results to find PRJ-9 manually:

```bash
# Fallback: fetch all projects and grep
curl -s -X POST "https://api.notion.com/v1/databases/${NOTION_DB_ID}/query" \
  -H "Authorization: Bearer ${NOTION_API_KEY}" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{}' | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in data.get('results', []):
    title_parts = r.get('properties', {}).get('Name', {}).get('title', [])
    title = ''.join(t.get('plain_text', '') for t in title_parts)
    status = r.get('properties', {}).get('Status', {}).get('select', {}).get('name', 'unknown')
    print(f'{r[\"id\"]} | {status} | {title}')
"
```

### Step 3: Check current status and update to "Execute"

First, inspect the Status property structure to confirm the exact select option name:

```bash
# Fetch page details to see current status
curl -s "https://api.notion.com/v1/pages/${PRJ9_PAGE_ID}" \
  -H "Authorization: Bearer ${NOTION_API_KEY}" \
  -H "Notion-Version: 2022-06-28" | python3 -c "
import json, sys
data = json.load(sys.stdin)
status = data.get('properties', {}).get('Status', {})
print('Status property:', json.dumps(status, indent=2))
"
```

Note whether the Status property type is `select` or `status`. Then apply the update:

```bash
# Update Status to "Execute"
UPDATE_RESPONSE=$(curl -s -X PATCH "https://api.notion.com/v1/pages/${PRJ9_PAGE_ID}" \
  -H "Authorization: Bearer ${NOTION_API_KEY}" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{
    "properties": {
      "Status": {
        "select": {
          "name": "Execute"
        }
      }
    }
  }')

echo "$UPDATE_RESPONSE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
if 'object' in data and data['object'] == 'error':
    print('ERROR:', data)
    sys.exit(1)
status = data.get('properties', {}).get('Status', {}).get('select', {}).get('name', 'unknown')
print('Updated status:', status)
print('Page ID:', data.get('id'))
print('Last edited:', data.get('last_edited_time'))
"
```

If the Status property uses `status` type instead of `select`, use:

```bash
# Alternative if property type is "status" (not "select")
curl -s -X PATCH "https://api.notion.com/v1/pages/${PRJ9_PAGE_ID}" \
  -H "Authorization: Bearer ${NOTION_API_KEY}" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{
    "properties": {
      "Status": {
        "status": {
          "name": "Execute"
        }
      }
    }
  }' | python3 -m json.tool
```

### Step 4: Verify the status change was applied

```bash
# Re-fetch the page and confirm status
curl -s "https://api.notion.com/v1/pages/${PRJ9_PAGE_ID}" \
  -H "Authorization: Bearer ${NOTION_API_KEY}" \
  -H "Notion-Version: 2022-06-28" | python3 -c "
import json, sys
data = json.load(sys.stdin)
status_prop = data.get('properties', {}).get('Status', {})
# Handle both select and status types
status_name = (
    status_prop.get('select', {}).get('name') or
    status_prop.get('status', {}).get('name') or
    'UNKNOWN'
)
print('Current status:', status_name)
if status_name == 'Execute':
    print('SUCCESS: PRJ-9 is now in Execute status')
else:
    print('WARNING: Status is not Execute, got:', status_name)
    sys.exit(1)
"
```

### Step 5: Resolve escalation esc_1773798905776_nehxrrg8g (if pending)

```bash
# Check escalation status first
ESC_CHECK=$(curl -s "${AGENT_FORGE_URL}/api/escalations/esc_1773798905776_nehxrrg8g" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}")

echo "$ESC_CHECK" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print('Escalation status:', data.get('status', 'not found'))
    print('Reason:', data.get('reason', 'N/A'))
except:
    print('Could not parse response or escalation not found')
" 2>/dev/null || echo "Escalation check skipped (endpoint may not support GET)"

# Resolve the escalation
RESOLVE_RESPONSE=$(curl -s -X POST "${AGENT_FORGE_URL}/api/escalations/esc_1773798905776_nehxrrg8g/resolve" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "resolution": "Self-referencing dependency fix merged via PR #228 (commit 33cd8e29) on 2026-03-18. Decomposer now warns+filters self-references instead of throwing. PRJ-9 Notion status reset to Execute for re-decomposition."
  }')

echo "Escalation resolve response:"
echo "$RESOLVE_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESOLVE_RESPONSE"
```

If the resolve endpoint returns 404 (escalation already resolved or different endpoint shape), that's acceptable — log it and continue.

### Step 6: Verification summary

```bash
echo "=== PRJ-9 Reset Summary ==="
echo ""
echo "1. Notion page ID: ${PRJ9_PAGE_ID}"
echo "2. Status update: Failed -> Execute"
echo "3. Escalation esc_1773798905776_nehxrrg8g: resolved (or already resolved)"
echo ""
echo "Next: ATC will pick up PRJ-9 on its next cycle and run decomposition"
echo "with the fixed decomposer (PR #228, 33cd8e29)."
```

### Step 7: Commit the handoff file and open PR

Since this is a pure data update (no source code changes), commit only the handoff file itself as a record:

```bash
git add -A
git commit -m "fix: reset PRJ-9 to Execute in Notion for re-decomposition

- Updated PRJ-9 (PA Real Estate Agent v2) Notion status: Failed -> Execute
- Root cause (self-referencing dependency) fixed in PR #228 (33cd8e29)
- Resolved escalation esc_1773798905776_nehxrrg8g
- ATC will re-attempt decomposition on next cycle with fixed decomposer"

git push origin feat/reset-prj9-execute-notion

gh pr create \
  --title "fix: reset PRJ-9 to Execute in Notion for re-decomposition" \
  --body "## Summary

Resets PRJ-9 (PA Real Estate Agent v2) Notion status from **Failed** → **Execute** so the ATC picks it up for re-decomposition.

## Root Cause

The decomposer threw on a self-referencing dependency (Item 17) in PRJ-9's plan. Fixed in PR #228 (commit 33cd8e29): decomposer now warns+filters self-references instead of throwing.

## Changes Made

- **Notion data update**: PRJ-9 status set to \`Execute\` via Notion API
- **Escalation resolved**: \`esc_1773798905776_nehxrrg8g\` marked resolved
- **No source code changes**

## Verification

- Re-fetched PRJ-9 page after update and confirmed status = \`Execute\`
- ATC will detect on next cycle and trigger decomposition with fixed code

## Risk

Low — pure Notion data update, no code changes." \
  --label "fix"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever has been completed
2. Open the PR with partial status

```bash
git add -A
git commit -m "fix: partial - reset PRJ-9 Notion status (incomplete)"
git push origin feat/reset-prj9-execute-notion
gh pr create --title "fix: reset PRJ-9 to Execute (partial)" --body "Partial execution - see ISSUES below"
```

3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/reset-prj9-execute-notion
FILES CHANGED: handoffs/reset-prj9-execute-notion.md
SUMMARY: Attempted to reset PRJ-9 Notion status from Failed to Execute and resolve escalation esc_1773798905776_nehxrrg8g
ISSUES: [describe what failed — e.g., NOTION_API_KEY not set, page not found, status property name mismatch]
NEXT STEPS: [e.g., Manually update PRJ-9 status in Notion UI at https://notion.so, or set NOTION_API_KEY secret and retry]
```

## Escalation Protocol

If NOTION_API_KEY is missing or PRJ-9 cannot be found after exhausting the fallback query:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "reset-prj9-execute-notion",
    "reason": "Cannot reset PRJ-9 Notion status: NOTION_API_KEY missing or PRJ-9 page not found in database b1eb06a469ac4a9eb3f01851611fb80b",
    "confidenceScore": 0.1,
    "contextSnapshot": {
      "step": "Step 2-3",
      "error": "NOTION_API_KEY not set or query returned no results for PRJ-9 / PA Real Estate Agent v2",
      "filesChanged": ["handoffs/reset-prj9-execute-notion.md"]
    }
  }'
```