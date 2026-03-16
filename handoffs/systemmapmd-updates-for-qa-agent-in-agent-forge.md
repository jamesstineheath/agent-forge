# Agent Forge -- SYSTEM_MAP.md Updates for QA Agent

## Metadata
- **Branch:** `feat/system-map-qa-agent`
- **Priority:** medium
- **Model:** sonnet
- **Type:** docs
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** docs/SYSTEM_MAP.md

## Context

The Agent Forge system has gained a fifth TLM agent: the QA Agent. It runs post-deploy verification via Playwright + HTTP smoke tests, triggers on `deployment_status` and `check_suite` events, and runs in parallel with Code Review after a PR is opened. The QA Agent uses a `QA_BYPASS_SECRET` auth bypass pattern for testing protected routes.

The current `docs/SYSTEM_MAP.md` does not document this agent. This handoff updates the system map to reflect the QA Agent's existence, pipeline position, file locations, and environment variable requirements. Changes are purely documentation — no code logic is affected.

## Requirements

1. Add QA Agent box to the Data Plane section of the ASCII architecture diagram
2. Add two rows to the Data Plane key files table: one for the action and one for the workflow
3. Update the Execution Flow diagram to show QA Agent running in parallel with TLM Code Review after "PR opened"
4. Add a note about QA Agent Tier 1 status and graduation criteria (20+ runs, <10% false-negative rate) — add a new subsection or append to the existing agent evaluation section if present, otherwise add a new "Agent Evaluation" section
5. Document the auth bypass pattern in the Integration Points section
6. Add `QA_BYPASS_SECRET` to the Environment Variables table under Agent Forge (Vercel) and under Target Repos (GitHub Secrets)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/system-map-qa-agent
```

### Step 1: Read the current SYSTEM_MAP.md

```bash
cat docs/SYSTEM_MAP.md
```

Carefully read the entire file to understand the current structure before making any edits.

### Step 2: Update the Data Plane architecture diagram

Locate the ASCII diagram's Data Plane section. It currently shows boxes for:
- Execute Handoff
- TLM Spec Review
- TLM Code Review
- TLM Outcome Tracker
- Handoff Lifecycle Orchestrator
- CI Stuck PR Monitor
- Feedback Compiler
- Repo Metadata

Add a QA Agent box. Insert it logically near TLM Code Review (since it runs in parallel). Example placement — add a new box in the grid:

```
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  TLM QA      │  │ Feedback     │  │    Repo      │  │
│  │   Agent      │  │ Compiler     │  │  Metadata    │  │
│  │ (post-deploy │  │ (weekly cron)│  │ (CLAUDE.md,  │  │
│  │  smoke tests)│  │ (ADR-009,    │  │ system map,  │  │
│  └──────────────┘  │  in pipeline)│  │ ADRs, TLM    │  │
│                    └──────────────┘  │ memory)      │  │
│                                      └──────────────┘  │
```

Adjust the exact layout to fit naturally within the existing ASCII diagram without breaking column alignment.

### Step 3: Add rows to the Data Plane key files table

Find the Data Plane key files table. It has columns `| Subsystem | Path | Purpose |`. Add two rows after the existing TLM entries (e.g., after Feedback Compiler or in logical order):

```markdown
| TLM QA Agent | `.github/actions/tlm-qa-agent/` | Post-deploy verification via Playwright + HTTP |
| QA Agent workflow | `.github/workflows/tlm-qa-agent.yml` | Triggers on deployment_status + check_suite |
```

### Step 4: Update the Execution Flow diagram

Find the Execution Flow section. It currently shows sequential steps including "PR opened" followed by "TLM Code Review". Update to show QA Agent running in parallel:

Replace the block around PR opened / code review with something like:

```
            PR opened with execution results
                    ↓
            ┌──────────────────┬────────────────────┐
            │                  │                    │
     TLM Code Review    TLM QA Agent          (other checks)
     (defers if CI red) (post-deploy smoke)
            │                  │
            └──────────────────┘
                    ↓
            Auto-merge (if low-risk + CI passes + QA passes)
```

Keep it consistent with the existing ASCII style (arrows using `↓`, `→`, `│`).

### Step 5: Add Agent Evaluation section for QA Agent

Search for any existing "Agent Evaluation" or "TLM Evaluation" section. If none exists, add a new section after the Execution Flow or Data Flow section. Add content like:

```markdown
## Agent Evaluation

### TLM QA Agent — Tier 1

The QA Agent is currently in **Tier 1** (supervised mode). Graduation to Tier 2 (autonomous) requires:
- **20+ runs** recorded in `docs/tlm-action-ledger.json`
- **<10% false-negative rate** (smoke tests pass when deploy is actually broken)

Until graduation, QA Agent results are advisory only and do not block auto-merge.
```

If a section already exists, append the QA Agent subsection there.

### Step 6: Document auth bypass pattern in Integration Points

Find the Integration Points table. Add a row documenting the QA bypass:

```markdown
| TLM QA Agent | Target app (deployed) | HTTP smoke tests with `QA_BYPASS_SECRET` header to bypass auth on protected routes |
```

### Step 7: Add QA_BYPASS_SECRET to Environment Variables

Find the Environment Variables section. It has two subsections:

**Under "Agent Forge (Vercel)"**, add:
```markdown
| `QA_BYPASS_SECRET` | Shared secret for QA Agent to bypass auth on protected routes during smoke tests |
```

**Under "Target Repos (GitHub Secrets)"**, add:
```markdown
| `QA_BYPASS_SECRET` | Shared secret injected into deployed app; validated by QA Agent smoke tests |
```

### Step 8: Verify the file is valid Markdown

```bash
# Check no obvious syntax issues — look for unclosed backtick blocks or broken table rows
grep -n "^|" docs/SYSTEM_MAP.md | head -60
```

Also do a quick visual scan:
```bash
cat docs/SYSTEM_MAP.md
```

### Step 9: Commit, push, open PR

```bash
git add docs/SYSTEM_MAP.md
git commit -m "docs: update SYSTEM_MAP.md to document QA Agent as fifth TLM agent"
git push origin feat/system-map-qa-agent
gh pr create \
  --title "docs: SYSTEM_MAP.md updates for QA Agent" \
  --body "## Summary

Documents the TLM QA Agent (fifth TLM agent) in the Agent Forge system map.

## Changes
- Added QA Agent box to Data Plane architecture diagram
- Added \`tlm-qa-agent\` action and workflow rows to Data Plane key files table
- Updated Execution Flow to show QA Agent running in parallel with Code Review
- Added Agent Evaluation section documenting Tier 1 status and graduation criteria
- Added auth bypass pattern row to Integration Points table
- Added \`QA_BYPASS_SECRET\` to Environment Variables for both Agent Forge (Vercel) and Target Repos

## Risk
Low — documentation only, no code changes."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/system-map-qa-agent
FILES CHANGED: docs/SYSTEM_MAP.md
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If blocked (e.g., SYSTEM_MAP.md has unexpected structure that makes safe edits ambiguous):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "system-map-qa-agent",
    "reason": "SYSTEM_MAP.md structure differs from expected; cannot safely apply documentation updates without human review",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "Step 2-7",
      "error": "Unexpected file structure",
      "filesChanged": ["docs/SYSTEM_MAP.md"]
    }
  }'
```