# Agent Forge -- Add project retry wrappers in lib/projects.ts

## Metadata
- **Branch:** `feat/add-project-retry-wrappers`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/projects.ts

## Context

Agent Forge is a dev orchestration platform (Next.js on Vercel). The `lib/projects.ts` file manages project lifecycle operations, wrapping lower-level Notion API calls with domain-specific semantics. The ATC (Air Traffic Controller) in `lib/atc.ts` dispatches work and monitors executions.

This task adds three convenience wrappers to `lib/projects.ts` to support a project retry lifecycle. A recent PR added `queryRetryProjects()` to `lib/notion.ts` and `updateProjectProperties` already exists there. The new wrappers will allow the ATC to:
1. Fetch projects flagged for retry
2. Clear the retry flag and increment the retry count (re-queuing as "Execute")
3. Mark a project as permanently failed after exhausting retries

The existing pattern in `lib/projects.ts` looks like:

```typescript
export async function transitionProjectToComplete(projectId: string): Promise<void> {
  await updateProjectProperties(projectId, { Status: "Complete" });
}
```

Functions import from `lib/notion.ts` and call `updateProjectProperties` with a properties object.

## Requirements

1. `getRetryProjects(): Promise<Project[]>` is added and exported from `lib/projects.ts`, returning the result of `queryRetryProjects()` from `lib/notion.ts`
2. `clearRetryFlag(projectId: string, currentRetryCount: number): Promise<void>` is added and exported, calling `updateProjectProperties` with `Retry: false`, `Retry Count: currentRetryCount + 1`, and `Status: "Execute"`
3. `markProjectFailedFromRetry(projectId: string): Promise<void>` is added and exported, calling `updateProjectProperties` with `Retry: false` and `Status: "Failed"`
4. All three functions are exported from `lib/projects.ts`
5. `queryRetryProjects` is imported from `lib/notion.ts` (add to existing import if not already present)
6. `npx tsc --noEmit` passes with no errors

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/add-project-retry-wrappers
```

### Step 1: Inspect existing files

Read `lib/projects.ts` to understand the current structure, existing imports, and `updateProjectProperties` usage:

```bash
cat lib/projects.ts
```

Read `lib/notion.ts` to confirm the signatures of `queryRetryProjects` and `updateProjectProperties`:

```bash
grep -n "queryRetryProjects\|updateProjectProperties" lib/notion.ts | head -30
```

Also check the `Project` type:

```bash
grep -n "Project" lib/types.ts | head -20
```

### Step 2: Add the three wrappers to lib/projects.ts

Open `lib/projects.ts` and make the following changes:

**a) Ensure `queryRetryProjects` is imported from `lib/notion.ts`.**

Find the existing import line for `lib/notion.ts`. It likely looks something like:

```typescript
import { updateProjectProperties, ... } from "./notion";
```

Add `queryRetryProjects` to that import if it is not already there. For example:

```typescript
import { updateProjectProperties, queryRetryProjects, ... } from "./notion";
```

**b) Ensure `Project` type is imported** (it is likely already imported from `./types`). Verify with:

```bash
grep "Project" lib/projects.ts | head -5
```

**c) Append the three exported functions at the end of `lib/projects.ts`:**

```typescript
export async function getRetryProjects(): Promise<Project[]> {
  return queryRetryProjects();
}

export async function clearRetryFlag(
  projectId: string,
  currentRetryCount: number
): Promise<void> {
  await updateProjectProperties(projectId, {
    Retry: false,
    "Retry Count": currentRetryCount + 1,
    Status: "Execute",
  });
}

export async function markProjectFailedFromRetry(
  projectId: string
): Promise<void> {
  await updateProjectProperties(projectId, {
    Retry: false,
    Status: "Failed",
  });
}
```

> **Note:** The exact property key names (`"Retry"`, `"Retry Count"`, `"Status"`) must match what `updateProjectProperties` in `lib/notion.ts` expects. Verify by checking how existing callers (e.g., `transitionProjectToComplete`) pass properties. Adjust if the actual keys differ (e.g., `retry`, `retryCount`).

### Step 3: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

If there are type errors:
- If `Retry` property key is wrong, check `lib/notion.ts` for the correct property name used in `updateProjectProperties` calls
- If `Project` type is missing, add import: `import { Project } from "./types";`
- If `queryRetryProjects` return type doesn't match `Project[]`, check the actual return type and adjust the wrapper accordingly

Fix any errors and re-run until clean.

### Step 4: Build check

```bash
npm run build
```

Resolve any build errors before proceeding.

### Step 5: Commit, push, open PR

```bash
git add lib/projects.ts
git commit -m "feat: add project retry wrappers in lib/projects.ts"
git push origin feat/add-project-retry-wrappers
gh pr create \
  --title "feat: add project retry wrappers in lib/projects.ts" \
  --body "## Summary

Adds three convenience wrappers to \`lib/projects.ts\` for the project retry lifecycle:

- \`getRetryProjects()\` — wraps \`queryRetryProjects()\` from \`lib/notion.ts\`
- \`clearRetryFlag(projectId, currentRetryCount)\` — unchecks Retry, increments Retry Count, sets Status to 'Execute'
- \`markProjectFailedFromRetry(projectId)\` — unchecks Retry, sets Status to 'Failed'

These follow the existing pattern in \`lib/projects.ts\` where domain-specific wrappers call lower-level Notion helpers. The ATC will call these functions to manage the retry lifecycle.

## Changes
- \`lib/projects.ts\`: Added 3 exported functions + import for \`queryRetryProjects\`

## Verification
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/add-project-retry-wrappers
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If blocked (e.g., `updateProjectProperties` signature is incompatible, `queryRetryProjects` doesn't exist in `lib/notion.ts`, or type errors cannot be resolved after 3 attempts):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-project-retry-wrappers",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/projects.ts"]
    }
  }'
```