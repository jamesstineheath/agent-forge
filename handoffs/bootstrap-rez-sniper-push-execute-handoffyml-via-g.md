<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Bootstrap rez-sniper: push execute-handoff.yml via GitHub API

## Metadata
- **Branch:** `feat/bootstrap-rez-sniper-workflows`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** `handoffs/bootstrap-rez-sniper-workflows.md`, `scripts/bootstrap-rez-sniper.sh` (ephemeral, not committed)

## Context

The `jamesstineheath/rez-sniper` repository is missing the core GitHub Actions workflow files required to participate in the Agent Forge pipeline. When the dispatcher attempts to trigger work items against rez-sniper, it calls `workflow_dispatch` on `execute-handoff.yml` — which doesn't exist in that repo — resulting in 404 errors for all queued work items (including `ed4c524e` and `52380e5a`).

The fix is to copy three workflow files from `jamesstineheath/agent-forge` (this repo) into `jamesstineheath/rez-sniper` via the GitHub Contents API:
1. `.github/workflows/execute-handoff.yml` — the main execution workflow
2. `.github/workflows/tlm-spec-review.yml` — handoff spec review before execution
3. `.github/workflows/tlm-review.yml` — TLM code review on PRs

This task runs entirely via `gh` CLI API calls — no source files in agent-forge are modified (other than committing the handoff record). There is no overlap with the concurrent work item on `.github/actions/tlm-review/src/index.ts`.

After pushing the workflows, work items `ed4c524e` and `52380e5a` need to be reset to `ready` status so the dispatcher can re-attempt them.

## Requirements

1. Read each of the three workflow files from `jamesstineheath/agent-forge` main branch via `gh api`.
2. Write each file to `jamesstineheath/rez-sniper` at the identical path via `gh api` PUT (create or update).
3. Each commit message follows the pattern: `chore: bootstrap <filename> workflow`.
4. Verify all three files exist in rez-sniper after push by re-reading them via `gh api`.
5. Reset work items `ed4c524e` and `52380e5a` to `ready` status via the Agent Forge work items API so the dispatcher can re-dispatch them.
6. No modifications to `.github/actions/tlm-review/src/index.ts` or any files touched by the concurrent work item.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/bootstrap-rez-sniper-workflows
```

### Step 1: Verify gh CLI access to both repos

```bash
# Confirm read access to agent-forge workflows
gh api repos/jamesstineheath/agent-forge/contents/.github/workflows/execute-handoff.yml --jq '.name'

# Confirm write access to rez-sniper (expect 404 or existing file)
gh api repos/jamesstineheath/rez-sniper/contents/.github/workflows/execute-handoff.yml 2>&1 || true
```

If `gh api` returns auth errors, ensure `GH_PAT` or the default `gh` token has `repo` scope on `rez-sniper`. The `gh` CLI uses the token from `GH_TOKEN` env var or the stored credential.

### Step 2: Push execute-handoff.yml to rez-sniper

```bash
# Read the file content and SHA from agent-forge
AF_RESPONSE=$(gh api repos/jamesstineheath/agent-forge/contents/.github/workflows/execute-handoff.yml)
CONTENT=$(echo "$AF_RESPONSE" | jq -r '.content' | tr -d '\n')

# Check if the file already exists in rez-sniper (needed for SHA if updating)
RS_RESPONSE=$(gh api repos/jamesstineheath/rez-sniper/contents/.github/workflows/execute-handoff.yml 2>/dev/null || echo '{}')
EXISTING_SHA=$(echo "$RS_RESPONSE" | jq -r '.sha // empty')

# Build the PUT request
if [ -n "$EXISTING_SHA" ]; then
  gh api repos/jamesstineheath/rez-sniper/contents/.github/workflows/execute-handoff.yml \
    -X PUT \
    -f message="chore: bootstrap execute-handoff workflow" \
    -f content="$CONTENT" \
    -f sha="$EXISTING_SHA"
else
  gh api repos/jamesstineheath/rez-sniper/contents/.github/workflows/execute-handoff.yml \
    -X PUT \
    -f message="chore: bootstrap execute-handoff workflow" \
    -f content="$CONTENT"
fi

echo "✅ execute-handoff.yml pushed"
```

### Step 3: Push tlm-spec-review.yml to rez-sniper

```bash
AF_RESPONSE=$(gh api repos/jamesstineheath/agent-forge/contents/.github/workflows/tlm-spec-review.yml)
CONTENT=$(echo "$AF_RESPONSE" | jq -r '.content' | tr -d '\n')

RS_RESPONSE=$(gh api repos/jamesstineheath/rez-sniper/contents/.github/workflows/tlm-spec-review.yml 2>/dev/null || echo '{}')
EXISTING_SHA=$(echo "$RS_RESPONSE" | jq -r '.sha // empty')

if [ -n "$EXISTING_SHA" ]; then
  gh api repos/jamesstineheath/rez-sniper/contents/.github/workflows/tlm-spec-review.yml \
    -X PUT \
    -f message="chore: bootstrap tlm-spec-review workflow" \
    -f content="$CONTENT" \
    -f sha="$EXISTING_SHA"
else
  gh api repos/jamesstineheath/rez-sniper/contents/.github/workflows/tlm-spec-review.yml \
    -X PUT \
    -f message="chore: bootstrap tlm-spec-review workflow" \
    -f content="$CONTENT"
fi

echo "✅ tlm-spec-review.yml pushed"
```

### Step 4: Push tlm-review.yml to rez-sniper

```bash
AF_RESPONSE=$(gh api repos/jamesstineheath/agent-forge/contents/.github/workflows/tlm-review.yml)
CONTENT=$(echo "$AF_RESPONSE" | jq -r '.content' | tr -d '\n')

RS_RESPONSE=$(gh api repos/jamesstineheath/rez-sniper/contents/.github/workflows/tlm-review.yml 2>/dev/null || echo '{}')
EXISTING_SHA=$(echo "$RS_RESPONSE" | jq -r '.sha // empty')

if [ -n "$EXISTING_SHA" ]; then
  gh api repos/jamesstineheath/rez-sniper/contents/.github/workflows/tlm-review.yml \
    -X PUT \
    -f message="chore: bootstrap tlm-review workflow" \
    -f content="$CONTENT" \
    -f sha="$EXISTING_SHA"
else
  gh api repos/jamesstineheath/rez-sniper/contents/.github/workflows/tlm-review.yml \
    -X PUT \
    -f message="chore: bootstrap tlm-review workflow" \
    -f content="$CONTENT"
fi

echo "✅ tlm-review.yml pushed"
```

### Step 5: Verify all three files exist in rez-sniper

```bash
echo "--- Verifying rez-sniper workflow files ---"

for FILE in execute-handoff.yml tlm-spec-review.yml tlm-review.yml; do
  RESULT=$(gh api repos/jamesstineheath/rez-sniper/contents/.github/workflows/$FILE --jq '.name' 2>&1)
  if [ "$RESULT" = "$FILE" ]; then
    echo "✅ $FILE present in rez-sniper"
  else
    echo "❌ $FILE MISSING: $RESULT"
    exit 1
  fi
done

echo "--- All workflow files verified ---"
```

### Step 6: Reset work items ed4c524e and 52380e5a to ready

These work items were stuck in a failed/parked state because the workflow didn't exist. Now that the workflow is in place, reset them so the dispatcher picks them up.

```bash
# Reset work item ed4c524e to ready
curl -X PATCH "${AGENT_FORGE_URL}/api/work-items/ed4c524e" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"status": "ready"}' \
  && echo "✅ ed4c524e reset to ready"

# Reset work item 52380e5a to ready
curl -X PATCH "${AGENT_FORGE_URL}/api/work-items/52380e5a" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{"status": "ready"}' \
  && echo "✅ 52380e5a reset to ready"
```

> **Note:** If `AGENT_FORGE_URL` is not set in the execution environment, use the production URL from CLAUDE.md. If the PATCH endpoint doesn't exist or returns 404/405, try `PUT` with the full work item body, or update the status field directly via the Vercel Blob storage key `af-data/work-items/<id>` using `gh` or a direct blob write. Escalate if neither works.

### Step 7: Commit the handoff record

The actual workflow changes are committed directly to rez-sniper via the GitHub API in steps 2–4. The only thing committed to agent-forge is this handoff file:

```bash
git add -A
git commit -m "chore: handoff record for bootstrapping rez-sniper workflow suite"
git push origin feat/bootstrap-rez-sniper-workflows
```

### Step 8: Verification

```bash
# TypeScript should still compile clean (we haven't changed any .ts files)
npx tsc --noEmit
```

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "chore: handoff record for bootstrapping rez-sniper workflow suite" --allow-empty
git push origin feat/bootstrap-rez-sniper-workflows

gh pr create \
  --title "chore: bootstrap rez-sniper execute-handoff + TLM workflow suite" \
  --body "## Summary

Pushes the three core Agent Forge pipeline workflows to \`jamesstineheath/rez-sniper\` via the GitHub Contents API so that work item dispatch no longer 404s.

### Workflows pushed to rez-sniper
- \`.github/workflows/execute-handoff.yml\`
- \`.github/workflows/tlm-spec-review.yml\`
- \`.github/workflows/tlm-review.yml\`

### Work items unblocked
- \`ed4c524e\` — reset to \`ready\`
- \`52380e5a\` — reset to \`ready\`

### No agent-forge source changes
All workflow content was copied from agent-forge → rez-sniper via API. The only change in this repo is this handoff record file.

Closes: rez-sniper pipeline bootstrap"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/bootstrap-rez-sniper-workflows
FILES CHANGED: [handoffs/bootstrap-rez-sniper-workflows.md]
SUMMARY: [what was done — which of the 3 workflow files were pushed successfully]
ISSUES: [which step failed and what error was returned]
NEXT STEPS: [which files remain to push; whether work item reset succeeded]
```

## Escalation

If the `gh api` PUT calls fail with permission errors (403), or if the work item reset API returns unexpected errors after 3 attempts, escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "bootstrap-rez-sniper-workflows",
    "reason": "GitHub API PUT to rez-sniper/.github/workflows/ failed with permission error — GH_PAT may lack write access to rez-sniper",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "2-4",
      "error": "<paste gh api error here>",
      "filesChanged": ["handoffs/bootstrap-rez-sniper-workflows.md"]
    }
  }'
```