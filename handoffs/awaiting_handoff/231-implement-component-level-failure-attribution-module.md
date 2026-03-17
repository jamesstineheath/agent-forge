# Handoff 231: implement-component-level-failure-attribution-module

## Metadata
- Branch: `feat/implement-component-level-failure-attribution-module`
- Priority: high
- Model: opus
- Type: feature
- Max Budget: $5
- Risk Level: low
- Complexity: moderate
- Depends On: 04a49052-6350-4c5b-baf9-e7ecf193cead
- Date: 2026-03-17
- Executor: Claude Code (GitHub Actions)

## Context

Part of PRJ-20. Dependency `04a49052` ("Add evaluation metric types and interfaces to lib/types.ts") is now merged. This work item creates the failure attribution module that the downstream item `9e38cb57` ("Integrate attribution into ATC failed work item handling") depends on.

The goal is a rule-based (no LLM) module that systematically identifies which pipeline component caused a work item failure, using heuristics against available context (PR description, CI logs, review comments, etc).

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] lib/types.ts has been read and WorkItem interface is understood
- [ ] lib/attribution.ts does not already exist (or its contents have been read)
- [ ] 04a49052 types (evaluation metric types) are present in lib/types.ts

## Step 0: Branch, commit handoff, push

Create branch `feat/implement-component-level-failure-attribution-module` from `main`. Commit this handoff file. Push.

## Step 1: Read lib/types.ts to understand WorkItem, ComponentAttribution (if it exists), and any existing attribution-related types. Read lib/attribution.ts if it exists.

## Step 2: Create lib/attribution.ts with:
- `AttributionContext` type: `{ prDescription?: string, ciLogs?: string, reviewComments?: string, specReviewOutput?: string, executionLog?: string }`
- `ComponentAttribution` type: `{ component: string, confidence: 'high' | 'medium' | 'low', evidence: string }`
- `attributeFailure(workItem: WorkItem, context: AttributionContext): Promise<ComponentAttribution[]>` — rule-based heuristics:
  - CI failed with build/type errors → attribute to 'executor' (high confidence)
  - TLM code review rejected → attribute to 'executor' or 'spec-reviewer' based on rejection reason
  - PR has merge conflicts → attribute to 'orchestrator' (branch management)
  - Work item had missing dependencies when dispatched → attribute to 'decomposer'
  - QA smoke tests failed → attribute to 'qa-agent' or 'executor'
  - No PR created at all → attribute to 'executor' (execution failure)
  - Returns results sorted by confidence descending
- `getAttributionSummary(attributions: ComponentAttribution[]): string` — human-readable summary
- `getTopAttribution(attributions: ComponentAttribution[]): ComponentAttribution | null` — highest confidence item

## Step 3: Add optional `attribution?: ComponentAttribution[]` field to the WorkItem interface in lib/types.ts

## Step 4: Run `npm run build` and fix any TypeScript errors

## Step 5: Run existing tests with `npm test -- --no-coverage` to verify no regressions

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: implement-component-level-failure-attribution-module (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "feat/implement-component-level-failure-attribution-module",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```