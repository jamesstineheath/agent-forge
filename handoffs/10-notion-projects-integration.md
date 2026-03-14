# Handoff 10: Notion Projects Integration

## Metadata
- **Branch:** `feat/notion-projects-integration`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $8
- **Risk Level:** medium
- **Complexity:** Moderate (6 files new, 3 files modified)
- **Estimated files:** `lib/notion.ts`, `lib/projects.ts`, `lib/types.ts`, `lib/hooks.ts`, `lib/atc.ts`, `app/api/projects/route.ts`, `app/(app)/page.tsx`, `package.json`

## Context

Agent Forge Phase 2e-1 adds Notion as the project trigger layer. A "Projects" database has been created in Notion (DB ID: `b1eb06a469ac4a9eb3f01851611fb80b`, data source ID: `79757fe1-15e4-46f1-b7fc-b758fbab367c`) with this schema:

- **Project** (title)
- **Plan URL** (url): link to the Notion plan page
- **Target Repo** (select): `personal-assistant`, `rez-sniper`, `agent-forge`
- **Status** (select): `Draft`, `Ready`, `Execute`, `Executing`, `Complete`, `Failed`
- **Priority** (select): `P0`, `P1`, `P2`
- **Complexity** (select): `Simple`, `Moderate`, `Complex`
- **Risk Level** (select): `Low`, `Medium`, `High`
- **Project ID** (unique_id, auto-increment): `PRJ-N`
- **Created** (created_time)

The trigger flow: a human (or planning session) sets a project's Status to "Execute" in Notion. The ATC detects this on its next sweep, transitions it to "Executing", and logs an event. Actual decomposition into work items is deferred to Phase 2e-3 (Plan Decomposer). For now, the ATC just detects and transitions.

The dashboard gets a new "Projects" section showing all projects from Notion with their status, target repo, and priority.

**Environment variables required (set in Vercel before first deploy):**
- `NOTION_API_KEY`: Notion integration token (created at https://www.notion.so/my-integrations, shared with "Personal Assistant, Dev Workspace" page)
- `NOTION_PROJECTS_DB_ID`: `b1eb06a469ac4a9eb3f01851611fb80b`

**Local development note:** These env vars will NOT be set locally during execution. This is expected — the graceful degradation (returning empty arrays, no errors) IS the test for local dev.

## Pre-flight Self-Check

Before executing, confirm:
- [ ] You are on a fresh branch from `main`
- [ ] `lib/atc.ts` exists and contains `runATCCycle`
- [ ] `lib/types.ts` exists and contains `ATCEvent` and `ATCState`
- [ ] `lib/hooks.ts` exists and contains `useATCState` and `useWorkItems`
- [ ] `app/(app)/page.tsx` exists and renders the dashboard
- [ ] `app/api/` directory contains `atc/`, `repos/`, `work-items/`
- [ ] No open PRs touch the files we're modifying. Check with:
  ```bash
  gh pr list --state open --json files --jq '.[].files[].path' 2>/dev/null | grep -E '(lib/atc\.ts|lib/types\.ts|lib/hooks\.ts|app/\(app\)/page\.tsx)' && echo "CONFLICT: open PRs touch our files — check before proceeding" || echo "OK: no conflicting PRs"
  ```

If any check fails, stop and report in the abort protocol format.

## Step 0: Branch, commit handoff, push
