# Agent Forge -- Work Item Store + Repo Registry

## Metadata
- **Branch:** `feat/work-item-store`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $8
- **Risk Level:** low
- **Estimated files:** lib/types.ts, lib/work-items.ts, lib/repos.ts, app/api/work-items/route.ts, app/api/work-items/[id]/route.ts, app/api/repos/route.ts, app/api/repos/[id]/route.ts

## Context

Agent Forge needs a data layer for work items and registered repos. Work items are units of work targeting any repo (bugs, features, refactors). Repos are target repositories registered with Agent Forge that have the pipeline installed.

This is the first feature handoff going through the Agent Forge pipeline. It builds the CRUD API that the orchestrator (next handoff) and dashboard (later handoff) will consume.

## Requirements

1. TypeScript types for WorkItem and RepoConfig (see schemas below)
2. `lib/work-items.ts` with CRUD functions: `listWorkItems`, `getWorkItem`, `createWorkItem`, `updateWorkItem`, `deleteWorkItem`
3. `lib/repos.ts` with CRUD functions: `listRepos`, `getRepo`, `createRepo`, `updateRepo`, `deleteRepo`
4. API routes at `/api/work-items` (GET list, POST create) and `/api/work-items/[id]` (GET, PATCH, DELETE)
5. API routes at `/api/repos` (GET list, POST create) and `/api/repos/[id]` (GET, PATCH, DELETE)
6. All routes auth-protected (return 401 if not authenticated)
7. Zod validation on all inputs
8. TypeScript compiles with zero errors

## Schemas

### WorkItem

```typescript
interface WorkItem {
  id: string;                     // uuid
  title: string;
  description: string;
  targetRepo: string;             // e.g. "jamesstineheath/personal-assistant"
  source: {
    type: "pa-improvement" | "github-issue" | "manual";
    sourceId?: string;
    sourceUrl?: string;
  };
  priority: "high" | "medium" | "low";
  riskLevel: "low" | "medium" | "high";
  complexity: "simple" | "moderate" | "complex";
  status: "filed" | "ready" | "queued" | "generating" | "executing" | "reviewing" | "merged" | "failed" | "parked";
  dependencies: string[];         // IDs of items that must complete first
  handoff: {
    content: string;
    branch: string;
    budget: number;
    generatedAt: string;
  } | null;
  execution: {
    workflowRunId?: number;
    prNumber?: number;
    prUrl?: string;
    startedAt?: string;
    completedAt?: string;
    outcome?: "merged" | "failed" | "parked" | "reverted";
  } | null;
  createdAt: string;
  updatedAt: string;
}
```

### RepoConfig

```typescript
interface RepoConfig {
  id: string;                     // uuid
  fullName: string;               // "jamesstineheath/personal-assistant"
  shortName: string;              // "pa"
  claudeMdPath: string;           // "CLAUDE.md"
  systemMapPath?: string;         // "docs/SYSTEM_MAP.md"
  adrPath?: string;               // "docs/adr/"
  handoffDir: string;             // "handoffs/"
  executeWorkflow: string;        // "execute-handoff.yml"
  concurrencyLimit: number;       // max parallel executions
  defaultBudget: number;          // default $ if handoff omits
  createdAt: string;
  updatedAt: string;
}
```

## Execution Steps

### Step 0: Branch setup

```bash
git checkout -b feat/work-item-store
```

### Step 1: Create shared types

Create `lib/types.ts` with the WorkItem and RepoConfig interfaces above, plus Zod schemas for validation (`createWorkItemSchema`, `updateWorkItemSchema`, `createRepoSchema`, `updateRepoSchema`).

Install zod if not already present: `npm install zod`

### Step 2: Implement work item store

Create `lib/work-items.ts`:
- `listWorkItems(filters?)` -- loads all work items from `af-data/work-items/index`, supports filtering by status, targetRepo, priority
- `getWorkItem(id)` -- loads single item from `af-data/work-items/{id}`
- `createWorkItem(data)` -- generates UUID, sets createdAt/updatedAt, saves to blob, updates index
- `updateWorkItem(id, patch)` -- partial update, sets updatedAt
- `deleteWorkItem(id)` -- removes from blob and index

Storage pattern: each work item is stored individually at `af-data/work-items/{id}`. An index file at `af-data/work-items/index` holds a lightweight array of `{id, title, targetRepo, status, priority, updatedAt}` for fast list queries without loading every item.

### Step 3: Implement repo registry

Create `lib/repos.ts`:
- `listRepos()` -- loads all repos from `af-data/repos/index`
- `getRepo(id)` -- loads single repo config from `af-data/repos/{id}`
- `createRepo(data)` -- generates UUID, sets createdAt/updatedAt, saves
- `updateRepo(id, patch)` -- partial update
- `deleteRepo(id)` -- removes from blob and index

Same storage pattern: individual records + lightweight index.

### Step 4: Create API routes

Create `app/api/work-items/route.ts`:
- GET: list work items, accept query params for filtering (status, targetRepo, priority)
- POST: create work item, validate with Zod

Create `app/api/work-items/[id]/route.ts`:
- GET: single work item
- PATCH: partial update
- DELETE: remove

Create `app/api/repos/route.ts`:
- GET: list repos
- POST: create repo

Create `app/api/repos/[id]/route.ts`:
- GET: single repo
- PATCH: partial update
- DELETE: remove

All routes: check authentication via `auth()` from Auth.js. Return 401 JSON if not authenticated. Return proper error codes (404, 400, 500) with JSON error bodies.

### Step 5: Verification

```bash
npx tsc --noEmit      # zero errors
npm run build          # succeeds
```

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: work item store + repo registry with CRUD API

Adds the data layer for Agent Forge:
- WorkItem and RepoConfig types with Zod validation
- Vercel Blob persistence with index pattern for fast list queries
- RESTful API routes for both entities
- Auth-protected endpoints"
git push origin feat/work-item-store
gh pr create --title "feat: work item store + repo registry" --body "## Summary
Adds CRUD API for work items and repo configurations. This is the data foundation that the orchestrator and dashboard will build on.

## Files Changed
- lib/types.ts (shared types + Zod schemas)
- lib/work-items.ts (work item CRUD)
- lib/repos.ts (repo registry CRUD)
- app/api/work-items/ (API routes)
- app/api/repos/ (API routes)

## Verification
- tsc --noEmit: pass
- npm run build: pass

## Risk
Low. New files only, no existing code modified."
```

For low-risk with passing verification, enable auto-merge:
```bash
gh pr merge --auto --squash
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status noted in the body
3. Output structured report:
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/work-item-store
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```
