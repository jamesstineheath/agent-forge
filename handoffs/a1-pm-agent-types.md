# Agent Forge -- A1: PM Agent Types

## Metadata
- **Branch:** `feat/pm-agent-types`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/types.ts

## Context

This is a foundational change to `lib/types.ts` that adds type definitions for the upcoming PM Agent feature. The PM Agent will handle backlog reviews, project health monitoring, plan validation, and digest generation. These types will be imported and used by other PM Agent components once implemented.

The existing `lib/types.ts` already contains types like `WorkItem`, `Project`, and source type unions. We need to append new interfaces without modifying any existing exports. The `WorkItem.source` field (if it exists as a union type) needs `'pm-agent'` added as a valid value.

## Requirements

1. `lib/types.ts` exports `BacklogReview` interface with all specified fields
2. `lib/types.ts` exports `BacklogRecommendation` interface with all specified fields
3. `lib/types.ts` exports `ProjectHealth` interface with all specified fields
4. `lib/types.ts` exports `PlanValidation` interface with all specified fields
5. `lib/types.ts` exports `PlanValidationIssue` interface with all specified fields
6. `lib/types.ts` exports `PMAgentConfig` interface with all specified fields
7. `lib/types.ts` exports `DigestOptions` interface with all specified fields
8. No `any` types used in any new interface
9. If `WorkItem.source` is a string union type, `'pm-agent'` is added as a valid value
10. All existing type exports remain unchanged and backward compatible
11. `npm run build` passes with no type errors

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/pm-agent-types
```

### Step 1: Inspect current lib/types.ts

Read the full contents of `lib/types.ts` to understand existing exports and find the `WorkItem.source` field definition.

```bash
cat lib/types.ts
```

### Step 2: Add PM Agent types to lib/types.ts

Append the following type definitions to the end of `lib/types.ts`. Do not modify any existing content.

If `WorkItem` has a `source` field typed as a string union (e.g., `'manual' | 'github' | 'notion' | ...`), add `'pm-agent'` to that union.

The types to add:

```typescript
export interface BacklogReview {
  id: string;
  timestamp: string;
  repos: string[];
  totalItemsReviewed: number;
  recommendations: BacklogRecommendation[];
  summary: string;
  notionPageId?: string;
}

export interface BacklogRecommendation {
  workItemId: string;
  action: 'dispatch' | 'defer' | 'kill' | 'escalate';
  priority: 'high' | 'medium' | 'low';
  rationale: string;
}

export interface ProjectHealth {
  projectId: string;
  projectName: string;
  status: 'healthy' | 'at-risk' | 'stalling' | 'blocked';
  completionRate: number;
  escalationCount: number;
  avgTimeInQueue: number;
  blockedItems: number;
  totalItems: number;
  mergedItems: number;
  failedItems: number;
  issues: string[];
}

export interface PlanValidation {
  projectId: string;
  valid: boolean;
  issues: PlanValidationIssue[];
  checkedAt: string;
}

export interface PlanValidationIssue {
  section: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface PMAgentConfig {
  enabled: boolean;
  dailySweepHour: number;
  repos: string[];
  maxRecommendations: number;
}

export interface DigestOptions {
  includeHealth: boolean;
  includeBacklog: boolean;
  includeRecommendations: boolean;
  recipientEmail?: string;
}
```

**Implementation note for the `source` union:** After reading `lib/types.ts`, search for the `source` field on `WorkItem`. It likely looks like:
```typescript
source: 'manual' | 'github' | 'pa' | 'project' | ...
```
Add `'pm-agent'` to that union if it exists and does not already include it. If `source` is typed as `string`, no change is needed.

### Step 3: Verification

```bash
npx tsc --noEmit
npm run build
```

If there are any type errors, fix them before proceeding. Common issues:
- Duplicate export names (check that none of the new interface names already exist in the file)
- Syntax errors from editing (verify the file ends properly)

### Step 4: Commit, push, open PR

```bash
git add lib/types.ts
git commit -m "feat: add PM Agent type definitions to lib/types.ts"
git push origin feat/pm-agent-types
gh pr create \
  --title "feat: A1 PM Agent Types" \
  --body "## Summary

Adds foundational PM Agent type definitions to \`lib/types.ts\`. This is a prerequisite for all other PM Agent components.

## New Types Added
- \`BacklogReview\` — represents a backlog review session with recommendations
- \`BacklogRecommendation\` — a single action recommendation for a work item
- \`ProjectHealth\` — health snapshot for a project (completion rate, escalations, etc.)
- \`PlanValidation\` — result of validating a project plan
- \`PlanValidationIssue\` — individual issue found during plan validation
- \`PMAgentConfig\` — configuration for the PM Agent
- \`DigestOptions\` — options for generating PM Agent digests

## Source Union Update
Added \`'pm-agent'\` to \`WorkItem.source\` union type if applicable.

## Risk
Low — additive changes only. No existing types modified."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/pm-agent-types
FILES CHANGED: [lib/types.ts]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If encountering a blocker that cannot be resolved autonomously (e.g., existing type names conflict with new ones, or the `source` union type structure is ambiguous):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "a1-pm-agent-types",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/types.ts"]
    }
  }'
```