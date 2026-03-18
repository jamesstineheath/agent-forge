<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Decomposer crashes on self-referencing dependencies instead of auto-correcting

## Metadata
- **Branch:** `fix/decomposer-self-reference-autocorrect`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/decomposer.ts

## Context

The decomposer (`lib/decomposer.ts`) validates dependencies when building a work item DAG. When a work item lists its own ID as a dependency (self-reference), the decomposer throws an error, causing the entire decomposition to fail (0 items created, project → Failed, escalation filed).

This has happened at least twice (PRJ-9 Item 17, PRJ-20 Item 7). The fix: detect self-references, log a warning, remove them from the dependency list, and continue normally.

**Scope boundary:** This work item fixes ONLY the code bug in `lib/decomposer.ts`. PRJ-9 recovery (resetting Notion status, resolving escalation `esc_1773798905776`) is being handled by a separate active work item on branch `fix/investigate-and-recover-prj-9-pa-real-estate-agent`. Do NOT create admin routes, scripts, or modify `lib/notion.ts` or `lib/projects.ts`.

## Requirements

1. In `lib/decomposer.ts`, replace the `throw` on self-referencing dependencies with a `console.warn` + filter.
2. Warning log format: `[decomposer] WARN: item <ID> self-references itself in dependencies, removing`
3. Self-reference removal must happen **before** topological sort / cycle detection.
4. All other dependency validation (cross-item cycles, missing deps) must remain unchanged.
5. TypeScript must compile (`npx tsc --noEmit`) and `npm run build` must pass.
6. Only `lib/decomposer.ts` should be modified.

## Execution Steps

### Step 0: Pre-flight checks
