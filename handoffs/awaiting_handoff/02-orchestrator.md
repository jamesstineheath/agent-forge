# Agent Forge -- Orchestrator Dispatch

## Metadata
- **Branch:** `feat/orchestrator`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $8
- **Risk Level:** medium
- **Estimated files:** lib/orchestrator.ts, lib/github.ts, app/api/orchestrator/dispatch/route.ts, app/api/orchestrator/status/route.ts

## Context

The orchestrator is Agent Forge's core component. When a human dispatches a work item, the orchestrator reads the target repo's context (CLAUDE.md, system map, recent PRs), calls Claude to generate a v3 handoff file, creates a branch in the target repo, pushes the handoff, and triggers the Execute Handoff workflow.

This handoff depends on the work item store and repo registry from the previous handoff (01-work-item-store). It should only be executed after that PR is merged.

## Requirements

1. `lib/github.ts` -- GitHub API helper for cross-repo operations (read files, create branches, push files, trigger workflows, check workflow runs)
2. `lib/orchestrator.ts` -- Core dispatch logic: read work item, fetch repo context, generate handoff via Claude, push to target repo, trigger execution
3. `/api/orchestrator/dispatch` POST endpoint -- takes `{ workItemId }`, runs the dispatch flow, returns execution metadata
4. `/api/orchestrator/status` GET endpoint -- returns current dispatch state and recent dispatches
5. Handoff generation uses Claude API (Vercel AI SDK) with repo context in the system prompt
6. Work item status updated throughout the flow: `ready` -> `generating` -> `queued` -> `executing`
7. Error handling: if any step fails, work item status set to `failed` with error details
8. TypeScript compiles with zero errors

## Execution Steps

### Step 0: Branch setup

```bash
git checkout main && git pull
git checkout -b feat/orchestrator
```

Verify `lib/work-items.ts` and `lib/repos.ts` exist (from previous handoff).

### Step 1: GitHub API helper

Create `lib/github.ts`:

Functions needed (all use the `GH_PAT` env var for auth):

```typescript
// Read a file from a repo (returns content as string, or null if not found)
async function readRepoFile(repo: string, path: string, branch?: string): Promise<string | null>

// List recent merged PRs (returns array of {number, title, files, mergedAt})
async function listRecentMergedPRs(repo: string, count?: number): Promise<MergedPR[]>

// Create a new branch from the repo's default branch
async function createBranch(repo: string, branchName: string): Promise<void>

// Push a file to a branch (create or update)
async function pushFile(repo: string, branch: string, path: string, content: string, message: string): Promise<void>

// Trigger a workflow via workflow_dispatch
async function triggerWorkflow(repo: string, workflowFile: string, branch: string, inputs?: Record<string, string>): Promise<void>

// Get workflow run status for a branch
async function getWorkflowRuns(repo: string, branch: string, workflowFile?: string): Promise<WorkflowRun[]>

// Get PR by branch name
async function getPRByBranch(repo: string, branch: string): Promise<PR | null>
```

Use `fetch` with GitHub REST API v3. Set `Authorization: Bearer ${process.env.GH_PAT}` header. Handle rate limiting gracefully (check `X-RateLimit-Remaining` header, log warnings below 100).

### Step 2: Repo context fetcher

Add to `lib/orchestrator.ts`:

```typescript
async function fetchRepoContext(repo: RepoConfig): Promise<RepoContext> {
  // Read CLAUDE.md
  // Read system map (if path configured)
  // List ADR files and read their contents (if path configured)
  // List recent 5 merged PRs with their titles and files changed
  // Return structured context object
}
```

The context object should be designed for inclusion in a Claude prompt. Keep it concise: truncate CLAUDE.md to first 3000 chars, ADR summaries to title + status + decision only, PR list to title + files only.

### Step 3: Handoff generator

Add to `lib/orchestrator.ts`:

```typescript
async function generateHandoff(workItem: WorkItem, repoContext: RepoContext, repoConfig: RepoConfig): Promise<string> {
  // Call Claude API via Vercel AI SDK
  // System prompt: "You are a dev orchestration agent generating handoff files..."
  // Include repo context, work item details, v3 format template
  // Return the generated markdown handoff content
}
```

The system prompt should include:
- The v3 handoff format template (metadata block, execution steps, verification, abort protocol)
- The target repo's CLAUDE.md content
- The target repo's system map
- ADR summaries
- Recent merged PR titles/files (for coding pattern awareness)
- The work item title, description, priority, risk level, complexity

Use `generateText` from `ai` package with `claude-sonnet-4-6` model. The generated handoff should be a complete, executable v3 markdown file.

Branch naming: derive from work item title. Slugify: lowercase, replace spaces with hyphens, prefix with `fix/` or `feat/` based on work item type. Example: "Fix bodyweight exercise logging" becomes `fix/bodyweight-exercise-logging`.

### Step 4: Dispatch flow

Add to `lib/orchestrator.ts`:

```typescript
async function dispatchWorkItem(workItemId: string): Promise<DispatchResult> {
  // 1. Load work item, verify status is "ready"
  // 2. Load repo config for the target repo
  // 3. Update work item status to "generating"
  // 4. Fetch repo context
  // 5. Generate handoff via Claude
  // 6. Determine branch name from work item
  // 7. Create branch in target repo
  // 8. Push handoff file to handoffs/ directory on the branch
  // 9. Update work item with handoff content, branch name
  // 10. Trigger execute-handoff workflow (or let Spec Review trigger it)
  //     Note: pushing to handoffs/ triggers Spec Review, which triggers Execute Handoff
  //     So we just need to push the file. No explicit workflow_dispatch needed.
  // 11. Update work item status to "executing", set execution.startedAt
  // 12. Return dispatch result with branch, handoff path
}
```

Error handling at each step: if any step fails, set work item status to "failed", store the error message in work item metadata, and throw. The API route catches and returns a proper error response.

### Step 5: API routes

Create `app/api/orchestrator/dispatch/route.ts`:
- POST: accepts `{ workItemId: string }`
- Validates input
- Calls `dispatchWorkItem`
- Returns `{ success: true, branch, handoffPath }` or `{ success: false, error }`
- Auth-protected

Create `app/api/orchestrator/status/route.ts`:
- GET: returns recent dispatches (last 10 work items with status "generating", "executing", "reviewing", "merged", "failed")
- Uses `listWorkItems` with appropriate filters
- Auth-protected

### Step 6: Verification

```bash
npx tsc --noEmit      # zero errors
npm run build          # succeeds
```

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: orchestrator dispatch with Claude handoff generation

Adds the core orchestration engine:
- GitHub API helper for cross-repo operations
- Repo context fetcher (reads CLAUDE.md, system map, ADRs, recent PRs)
- Handoff generator using Claude API + v3 format
- Dispatch flow: generates handoff, pushes to target repo, triggers pipeline
- API endpoints for dispatch and status"
git push origin feat/orchestrator
gh pr create --title "feat: orchestrator dispatch engine" --body "## Summary
Core orchestration: takes a work item, reads target repo context, generates a v3 handoff via Claude, pushes it to the target repo branch (triggering the Spec Review -> Execute -> Code Review pipeline).

## Files Changed
- lib/github.ts (GitHub API helper)
- lib/orchestrator.ts (dispatch logic + handoff generation)
- app/api/orchestrator/dispatch/route.ts
- app/api/orchestrator/status/route.ts

## Verification
- tsc --noEmit: pass
- npm run build: pass

## Risk
Medium. Calls external APIs (GitHub, Claude). No destructive operations -- creates branches and files only.

## Dependencies
Requires 01-work-item-store to be merged first."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/orchestrator
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```
