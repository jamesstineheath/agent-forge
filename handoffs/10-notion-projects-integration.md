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

## Pre-flight Self-Check

Before executing, confirm:
- [ ] You are on a fresh branch from `main`
- [ ] `lib/atc.ts` exists and contains `runATCCycle`
- [ ] `lib/types.ts` exists and contains `ATCEvent` and `ATCState`
- [ ] `lib/hooks.ts` exists and contains `useATCState` and `useWorkItems`
- [ ] `app/(app)/page.tsx` exists and renders the dashboard
- [ ] `app/api/` directory contains `atc/`, `repos/`, `work-items/`
- [ ] No open PRs touch `lib/atc.ts`, `lib/types.ts`, `lib/hooks.ts`, or `app/(app)/page.tsx`

## Step 0: Branch, commit handoff, push

```bash
git checkout main && git pull
git checkout -b feat/notion-projects-integration
mkdir -p handoffs
cp handoffs/10-notion-projects-integration.md handoffs/ 2>/dev/null || true
# The handoff file itself will be committed in this step
git add handoffs/10-notion-projects-integration.md
git commit -m "chore: add handoff 10 - Notion projects integration"
git push origin feat/notion-projects-integration
```

## Step 1: Install Notion SDK

```bash
npm install @notionhq/client
```

Commit:
```bash
git add package.json package-lock.json
git commit -m "chore: install @notionhq/client"
```

## Step 2: Create `lib/notion.ts` (Notion client wrapper)

Create a thin wrapper around the Notion SDK that handles initialization and graceful degradation when `NOTION_API_KEY` is not set.

```typescript
// lib/notion.ts
import { Client } from "@notionhq/client";

let _client: Client | null = null;

export function getNotionClient(): Client | null {
  if (!process.env.NOTION_API_KEY) {
    return null;
  }
  if (!_client) {
    _client = new Client({ auth: process.env.NOTION_API_KEY });
  }
  return _client;
}

export function getProjectsDbId(): string | null {
  return process.env.NOTION_PROJECTS_DB_ID ?? null;
}
```

Commit:
```bash
git add lib/notion.ts
git commit -m "feat: add Notion client wrapper with graceful degradation"
```

## Step 3: Create `lib/projects.ts` (Projects data layer)

This module queries and updates the Notion Projects database. All functions return empty results (not errors) when the Notion client or DB ID is unavailable.

```typescript
// lib/projects.ts
import { getNotionClient, getProjectsDbId } from "./notion";

export interface NotionProject {
  id: string;           // Notion page ID
  projectId: string;    // Auto-increment PRJ-N
  title: string;
  planUrl: string | null;
  targetRepo: string | null;
  status: string;
  priority: string | null;
  complexity: string | null;
  riskLevel: string | null;
  createdAt: string;
}

function extractPlainText(richText: Array<{ plain_text: string }>): string {
  return richText.map((t) => t.plain_text).join("");
}

function parseProjectPage(page: Record<string, unknown>): NotionProject {
  const props = page.properties as Record<string, Record<string, unknown>>;

  const titleProp = props["Project"];
  const title = titleProp?.title
    ? extractPlainText(titleProp.title as Array<{ plain_text: string }>)
    : "Untitled";

  const planUrlProp = props["Plan URL"];
  const planUrl = (planUrlProp?.url as string) ?? null;

  const targetRepoProp = props["Target Repo"];
  const targetRepo = (targetRepoProp?.select as { name: string } | null)?.name ?? null;

  const statusProp = props["Status"];
  const status = (statusProp?.select as { name: string } | null)?.name ?? "Draft";

  const priorityProp = props["Priority"];
  const priority = (priorityProp?.select as { name: string } | null)?.name ?? null;

  const complexityProp = props["Complexity"];
  const complexity = (complexityProp?.select as { name: string } | null)?.name ?? null;

  const riskProp = props["Risk Level"];
  const riskLevel = (riskProp?.select as { name: string } | null)?.name ?? null;

  const projectIdProp = props["Project ID"];
  const projectIdObj = projectIdProp?.unique_id as { prefix: string; number: number } | undefined;
  const projectId = projectIdObj ? `${projectIdObj.prefix}-${projectIdObj.number}` : "PRJ-?";

  const createdProp = props["Created"];
  const createdAt = (createdProp?.created_time as string) ?? new Date().toISOString();

  return {
    id: page.id as string,
    projectId,
    title,
    planUrl,
    targetRepo,
    status,
    priority,
    complexity,
    riskLevel,
    createdAt,
  };
}

export async function getAllProjects(): Promise<NotionProject[]> {
  const notion = getNotionClient();
  const dbId = getProjectsDbId();
  if (!notion || !dbId) return [];

  try {
    const response = await notion.databases.query({
      database_id: dbId,
      sorts: [{ property: "Created", direction: "descending" }],
    });
    return response.results.map((page) => parseProjectPage(page as Record<string, unknown>));
  } catch (err) {
    console.error("[projects] Failed to query Notion:", err);
    return [];
  }
}

export async function getExecutableProjects(): Promise<NotionProject[]> {
  const notion = getNotionClient();
  const dbId = getProjectsDbId();
  if (!notion || !dbId) return [];

  try {
    const response = await notion.databases.query({
      database_id: dbId,
      filter: {
        property: "Status",
        select: { equals: "Execute" },
      },
    });
    return response.results.map((page) => parseProjectPage(page as Record<string, unknown>));
  } catch (err) {
    console.error("[projects] Failed to query executable projects:", err);
    return [];
  }
}

export async function getActiveProjects(): Promise<NotionProject[]> {
  const notion = getNotionClient();
  const dbId = getProjectsDbId();
  if (!notion || !dbId) return [];

  try {
    const response = await notion.databases.query({
      database_id: dbId,
      filter: {
        or: [
          { property: "Status", select: { equals: "Execute" } },
          { property: "Status", select: { equals: "Executing" } },
        ],
      },
    });
    return response.results.map((page) => parseProjectPage(page as Record<string, unknown>));
  } catch (err) {
    console.error("[projects] Failed to query active projects:", err);
    return [];
  }
}

export async function updateProjectStatus(
  pageId: string,
  status: "Draft" | "Ready" | "Execute" | "Executing" | "Complete" | "Failed"
): Promise<boolean> {
  const notion = getNotionClient();
  if (!notion) return false;

  try {
    await notion.pages.update({
      page_id: pageId,
      properties: {
        Status: { select: { name: status } },
      },
    });
    return true;
  } catch (err) {
    console.error("[projects] Failed to update project status:", err);
    return false;
  }
}
```

Commit:
```bash
git add lib/projects.ts
git commit -m "feat: add projects data layer for Notion Projects DB"
```

## Step 4: Update `lib/types.ts`

Add the `"project_trigger"` event type to the `ATCEvent` type union. Find the existing `type` field on `ATCEvent` and add it:

```typescript
// In ATCEvent interface, update the type union:
type: "status_change" | "timeout" | "concurrency_block" | "auto_dispatch" | "conflict" | "retry" | "parked" | "error" | "cleanup" | "project_trigger";
```

No other type changes needed. The `NotionProject` interface lives in `lib/projects.ts` since it's Notion-specific and not part of the core work item model.

Commit:
```bash
git add lib/types.ts
git commit -m "feat: add project_trigger event type to ATCEvent"
```

## Step 5: Update `lib/atc.ts` (Add project polling to ATC sweep)

Add project polling between the branch cleanup step and the final state save. Import the projects module and add a new section to `runATCCycle()`.

At the top of the file, add the import:
```typescript
import { getExecutableProjects, updateProjectStatus } from "./projects";
```

After step 8 (branch cleanup) and before `return state;`, add a new section:

```typescript
  // 9. Project polling: detect Notion projects with Status = "Execute"
  try {
    const executableProjects = await getExecutableProjects();
    for (const project of executableProjects) {
      // Transition to "Executing" in Notion
      const updated = await updateProjectStatus(project.id, "Executing");
      if (updated) {
        const event = makeEvent(
          "project_trigger",
          project.projectId,
          "Execute",
          "Executing",
          `Project "${project.title}" (${project.projectId}) triggered. Target: ${project.targetRepo ?? "unset"}. Plan: ${project.planUrl ?? "none"}. Decomposition deferred to Phase 2e-3.`
        );
        events.push(event);
        console.log(`[atc] Project triggered: ${project.projectId} - ${project.title}`);
      }
    }
    // Re-save events if we added project trigger events
    if (executableProjects.length > 0) {
      const existing = (await loadJson<ATCEvent[]>(ATC_EVENTS_KEY)) ?? [];
      const updated = [...existing, ...events.filter(e => e.type === "project_trigger")].slice(-MAX_EVENTS);
      await saveJson(ATC_EVENTS_KEY, updated);
    }
  } catch (err) {
    console.error("[atc] Project polling failed:", err);
  }
```

**Important:** The `ATC_EVENTS_KEY` constant is already defined at the top of the file. The `loadJson` and `saveJson` imports are already present. The `makeEvent` function is already defined. This is purely additive code inserted before the `return state;` line.

Commit:
```bash
git add lib/atc.ts
git commit -m "feat: add project polling to ATC cycle (Phase 2e-1)"
```

## Step 6: Create `app/api/projects/route.ts` (Projects API route)

Create a new API route that returns all projects from Notion. This follows the same pattern as `app/api/repos/route.ts` and `app/api/work-items/route.ts`.

```typescript
// app/api/projects/route.ts
import { NextResponse } from "next/server";
import { getAllProjects } from "@/lib/projects";

export async function GET() {
  try {
    const projects = await getAllProjects();
    return NextResponse.json(projects);
  } catch (err) {
    console.error("[api/projects] Error:", err);
    return NextResponse.json(
      { error: "Failed to fetch projects" },
      { status: 500 }
    );
  }
}
```

Commit:
```bash
git add app/api/projects/route.ts
git commit -m "feat: add /api/projects route"
```

## Step 7: Update `lib/hooks.ts` (Add useProjects hook)

Add a new SWR hook for projects, following the existing pattern. Import the `NotionProject` type.

At the top, add the import:
```typescript
import type { NotionProject } from "@/lib/projects";
```

Add the hook at the bottom of the file:
```typescript
export function useProjects() {
  const { data, error, isLoading, mutate } = useSWR<NotionProject[]>(
    "/api/projects",
    fetcher,
    { refreshInterval: 30000 }
  );
  return { data, error, isLoading, mutate };
}
```

Commit:
```bash
git add lib/hooks.ts
git commit -m "feat: add useProjects SWR hook"
```

## Step 8: Update `app/(app)/page.tsx` (Add Projects section to dashboard)

Add a Projects section to the dashboard. Import `useProjects` from `@/lib/hooks`. Add it after the existing stats cards and before `<PipelineStatus />`.

Add to imports:
```typescript
import { useWorkItems, useRepos, useATCState, useProjects } from "@/lib/hooks";
```

Inside the component, add:
```typescript
const { data: projects, isLoading: projectsLoading } = useProjects();
```

Add a new card in the stats grid (inside `<div className="grid grid-cols-2 gap-4 sm:grid-cols-4">`):
```tsx
<Card>
  <CardHeader className="pb-2">
    <CardTitle className="text-sm font-medium text-muted-foreground">
      Projects
    </CardTitle>
  </CardHeader>
  <CardContent>
    <p className="text-3xl font-bold text-purple-600">
      {projectsLoading ? "—" : (projects?.length ?? 0)}
    </p>
  </CardContent>
</Card>
```

After the stats grid and before `<PipelineStatus />`, add a projects table section:

```tsx
{/* Projects from Notion */}
{!projectsLoading && projects && projects.length > 0 && (
  <Card>
    <CardHeader>
      <CardTitle>Projects</CardTitle>
    </CardHeader>
    <CardContent>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="pb-2 font-medium">ID</th>
              <th className="pb-2 font-medium">Project</th>
              <th className="pb-2 font-medium">Target Repo</th>
              <th className="pb-2 font-medium">Status</th>
              <th className="pb-2 font-medium">Priority</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id} className="border-b last:border-0">
                <td className="py-2 font-mono text-xs">{p.projectId}</td>
                <td className="py-2">
                  {p.planUrl ? (
                    <a
                      href={p.planUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      {p.title}
                    </a>
                  ) : (
                    p.title
                  )}
                </td>
                <td className="py-2 font-mono text-xs">{p.targetRepo ?? "—"}</td>
                <td className="py-2">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      p.status === "Executing"
                        ? "bg-amber-100 text-amber-800"
                        : p.status === "Execute"
                          ? "bg-blue-100 text-blue-800"
                          : p.status === "Complete"
                            ? "bg-green-100 text-green-800"
                            : p.status === "Failed"
                              ? "bg-red-100 text-red-800"
                              : "bg-gray-100 text-gray-800"
                    }`}
                  >
                    {p.status}
                  </span>
                </td>
                <td className="py-2 text-xs">{p.priority ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CardContent>
  </Card>
)}
```

Commit:
```bash
git add app/(app)/page.tsx
git commit -m "feat: add Projects section to dashboard"
```

## Verification

Run all checks:

```bash
# TypeScript compiles
npx tsc --noEmit

# Build succeeds
npm run build

# Dev server starts (run briefly to check for runtime crashes)
timeout 15 npm run dev || true

# Verify new files exist
test -f lib/notion.ts && echo "OK: lib/notion.ts" || echo "MISSING: lib/notion.ts"
test -f lib/projects.ts && echo "OK: lib/projects.ts" || echo "MISSING: lib/projects.ts"
test -f app/api/projects/route.ts && echo "OK: app/api/projects/route.ts" || echo "MISSING: app/api/projects/route.ts"
```

**Expected behavior when `NOTION_API_KEY` is not set:**
- Dashboard loads normally with Projects section hidden (empty array returned)
- ATC sweep runs without errors (project polling returns empty, logs nothing)
- `/api/projects` returns `[]`

**Expected behavior when `NOTION_API_KEY` IS set:**
- Dashboard shows Projects section with data from Notion
- ATC sweep detects projects with Status = "Execute" and transitions them to "Executing"
- `project_trigger` events appear in the ATC event log

## Step 9: Commit, push, open PR

```bash
git push origin feat/notion-projects-integration

gh pr create --title "feat: Notion Projects integration (Phase 2e-1)" --body "## Summary
- Adds Notion SDK integration (\`@notionhq/client\`) with graceful degradation
- New \`lib/notion.ts\`: Notion client wrapper (returns null if no API key)
- New \`lib/projects.ts\`: Projects data layer (query, filter, update status)
- New \`app/api/projects/route.ts\`: GET endpoint returning all projects
- ATC now polls for projects with Status = \"Execute\" and transitions to \"Executing\"
- Dashboard shows Projects section with status badges and plan links
- New \`useProjects\` SWR hook in \`lib/hooks.ts\`

## Architecture
This is the trigger layer for Phase 2e. When a project is set to \"Execute\" in Notion, the ATC detects it and transitions it to \"Executing\". Actual decomposition into work items (Plan Decomposer) is Phase 2e-3.

Graceful degradation: when \`NOTION_API_KEY\` is not set, all Notion calls return empty results. The ATC runs without errors, the dashboard shows no projects section.

## Prerequisites (manual, before deploy)
- [x] Notion integration token available (existing NOTION_API_KEY)
- [x] Dev Workspace shared with integration
- [x] \`NOTION_API_KEY\` set in Vercel env vars
- [x] \`NOTION_PROJECTS_DB_ID=b1eb06a469ac4a9eb3f01851611fb80b\` set in Vercel env vars

## Files Changed
- \`package.json\` / \`package-lock.json\` (new dep: @notionhq/client)
- \`lib/notion.ts\` (new)
- \`lib/projects.ts\` (new)
- \`lib/types.ts\` (added project_trigger event type)
- \`lib/atc.ts\` (added project polling section)
- \`lib/hooks.ts\` (added useProjects hook)
- \`app/api/projects/route.ts\` (new)
- \`app/(app)/page.tsx\` (added Projects section)

## Verification
- [x] npx tsc --noEmit passes
- [x] npm run build passes
- [ ] Dashboard loads with empty Projects section (no NOTION_API_KEY)
- [ ] ATC sweep runs without errors (no NOTION_API_KEY)
- [ ] After env vars set: Projects section populated from Notion

## Risk
Medium. Adds external dependency (Notion API). All Notion calls are wrapped in try/catch with empty-result fallback, so failure is silent, not breaking. Core ATC and work item flows are untouched except for the additive project polling section."

gh pr merge --auto --squash
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/notion-projects-integration
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```