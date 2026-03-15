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

This is a foundational task for the PM Agent feature set. All subsequent PM Agent modules (backlog reviewer, project health monitor, plan validator, digest composer) will depend on the types defined here.

`lib/types.ts` already contains shared types for `WorkItem`, `Project`, escalations, and related structures. The new PM Agent types must follow the same conventions: string IDs, ISO date strings, exported interfaces with JSDoc comments.

No existing types should be modified — this is purely additive.

## Requirements

1. Add `BacklogReviewItem` interface with fields: `workItemId`, `repo`, `title`, `priority`, `recommendation` (`'dispatch' | 'defer' | 'kill'`), `rationale`
2. Add `BacklogReview` interface with fields: `id`, `timestamp`, `items`, `summary`, `notionPageId?`
3. Add `ProjectHealth` interface with fields: `projectId`, `projectName`, `status`, `completionRate`, `escalationCount`, `avgTimeInQueue`, `blockedItems`, `flags`, `assessedAt`
4. Add `ProjectHealthReport` interface as a collection of `ProjectHealth` results with an overall summary field
5. Add `PlanValidationIssue` interface with fields: `section`, `severity` (`'error' | 'warning'`), `message`
6. Add `PlanValidation` interface with fields: `projectId`, `valid`, `issues`, `checkedAt`
7. Add `PMAgentConfig` interface with fields: `enabled`, `sweepSchedule`, `digestRecipient`, `autoReview`
8. Add `DigestOptions` interface with fields: `period` (`'daily' | 'weekly'`), `includeHealth`, `includeBacklog`, `includeRecommendations`
9. All 8 types must be exported from `lib/types.ts`
10. Each type must include a JSDoc comment describing its purpose
11. `npx tsc --noEmit` must pass with no errors
12. No existing exports modified or removed

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/pm-agent-types
```

### Step 1: Inspect existing types file

Read `lib/types.ts` in full to understand existing conventions, import patterns, and where to append the new types.

```bash
cat lib/types.ts
```

Take note of:
- How interfaces are ordered and grouped
- Whether there are barrel exports elsewhere (e.g., `index.ts`) that need updating
- Existing union type patterns (e.g., how status enums are expressed as string unions)

### Step 2: Append PM Agent types to lib/types.ts

At the end of `lib/types.ts`, add the following block. Adjust formatting to match the existing file's style (spacing, comment style, etc.).

```typescript
// ---------------------------------------------------------------------------
// PM Agent Types
// ---------------------------------------------------------------------------

/** An individual work item entry within a backlog review, with a triage recommendation. */
export interface BacklogReviewItem {
  /** The ID of the work item being reviewed. */
  workItemId: string;
  /** The target repository for this work item (e.g., "owner/repo"). */
  repo: string;
  /** Human-readable title of the work item. */
  title: string;
  /** Priority level of the work item. */
  priority: string;
  /** Triage recommendation: dispatch now, defer, or remove from backlog. */
  recommendation: 'dispatch' | 'defer' | 'kill';
  /** Rationale explaining the recommendation. */
  rationale: string;
}

/** Result of a full backlog review operation across queued work items. */
export interface BacklogReview {
  /** Unique identifier for this review run. */
  id: string;
  /** ISO 8601 timestamp of when the review was performed. */
  timestamp: string;
  /** Individual item assessments produced during the review. */
  items: BacklogReviewItem[];
  /** Human-readable summary of the overall review findings. */
  summary: string;
  /** Notion page ID if the review was written to a Notion page. */
  notionPageId?: string;
}

/** Health assessment for a single project at a point in time. */
export interface ProjectHealth {
  /** The ID of the project being assessed. */
  projectId: string;
  /** Human-readable name of the project. */
  projectName: string;
  /** Overall health status of the project. */
  status: 'healthy' | 'at-risk' | 'stalled' | 'blocked';
  /** Fraction of work items completed, from 0 (none) to 1 (all). */
  completionRate: number;
  /** Number of active or recent escalations for this project. */
  escalationCount: number;
  /** Average time work items spend in the queue, in hours. */
  avgTimeInQueue: number;
  /** IDs of work items currently in a blocked state. */
  blockedItems: string[];
  /** Specific issues or anomalies detected during the assessment. */
  flags: string[];
  /** ISO 8601 timestamp of when this assessment was performed. */
  assessedAt: string;
}

/** Aggregated health report covering all assessed projects. */
export interface ProjectHealthReport {
  /** Individual health assessments keyed by project ID. */
  projects: ProjectHealth[];
  /** ISO 8601 timestamp of when the report was generated. */
  generatedAt: string;
  /** Human-readable overall summary across all projects. */
  overallSummary: string;
}

/** An individual issue found during plan validation. */
export interface PlanValidationIssue {
  /** The section or field of the plan where the issue was found. */
  section: string;
  /** Severity of the issue: errors block dispatch, warnings are advisory. */
  severity: 'error' | 'warning';
  /** Human-readable description of the issue. */
  message: string;
}

/** Result of validating a project plan against PM Agent rules. */
export interface PlanValidation {
  /** The ID of the project whose plan was validated. */
  projectId: string;
  /** Whether the plan passed validation (no errors; warnings are allowed). */
  valid: boolean;
  /** List of issues found during validation. */
  issues: PlanValidationIssue[];
  /** ISO 8601 timestamp of when validation was performed. */
  checkedAt: string;
}

/** Configuration controlling PM Agent behaviour and scheduling. */
export interface PMAgentConfig {
  /** Whether PM Agent operations are active. */
  enabled: boolean;
  /** Cron expression defining how often the PM Agent sweep runs (e.g., "0 9 * * *" for daily at 9am). */
  sweepSchedule: string;
  /** Email address that receives digest and alert emails from the PM Agent. */
  digestRecipient: string;
  /** Whether the PM Agent automatically reviews and re-prioritises the backlog each sweep. */
  autoReview: boolean;
}

/** Options controlling the content and scope of a progress digest. */
export interface DigestOptions {
  /** Time period the digest covers. */
  period: 'daily' | 'weekly';
  /** Whether to include project health assessments in the digest. */
  includeHealth: boolean;
  /** Whether to include backlog review results in the digest. */
  includeBacklog: boolean;
  /** Whether to include triage recommendations in the digest. */
  includeRecommendations: boolean;
}
```

### Step 3: Verify TypeScript compiles cleanly

```bash
npx tsc --noEmit
```

If there are errors, inspect them carefully. Likely causes:
- A type references another type that doesn't exist yet — double-check spelling against the interfaces just added
- Formatting broke an adjacent declaration — check the lines immediately before the new block

Fix any issues before proceeding.

### Step 4: Verify no existing exports were modified

```bash
git diff lib/types.ts
```

Confirm the diff is **only additions** (lines starting with `+`). No existing exported interfaces or types should show modification (`-` lines on existing declarations).

### Step 5: Verification

```bash
npx tsc --noEmit
npm run build
```

`npm run build` may produce warnings about unused vars in other files — that is acceptable. It must not fail due to type errors in `lib/types.ts`.

### Step 6: Commit, push, open PR

```bash
git add lib/types.ts
git commit -m "feat: add PM Agent type definitions to lib/types.ts"
git push origin feat/pm-agent-types
gh pr create \
  --title "feat: A1 PM Agent Types" \
  --body "## Summary

Adds foundational PM Agent type definitions to \`lib/types.ts\`. This is a purely additive change — no existing exports are modified.

### New Types
- \`BacklogReviewItem\` — individual triage entry within a backlog review
- \`BacklogReview\` — full result of a backlog review operation
- \`ProjectHealth\` — health assessment for a single project
- \`ProjectHealthReport\` — aggregated report across all projects
- \`PlanValidationIssue\` — individual issue from plan validation
- \`PlanValidation\` — full plan validation result
- \`PMAgentConfig\` — PM Agent configuration
- \`DigestOptions\` — options for progress digest composition

All types include JSDoc comments and follow existing conventions (string IDs, ISO date strings, string union literals for status fields).

### Acceptance Criteria
- [x] All 8 types exported from \`lib/types.ts\`
- [x] \`npx tsc --noEmit\` passes
- [x] No existing exports modified or removed
- [x] JSDoc on every interface"
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
FILES CHANGED: lib/types.ts
SUMMARY: [what was done]
ISSUES: [what failed or remains]
NEXT STEPS: [what remains — e.g., specific interfaces not yet added]
```