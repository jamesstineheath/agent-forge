# Agent Forge -- Update ATC to dispatch direct-source items

## Metadata
- **Branch:** `feat/atc-dispatch-direct-source-items`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/atc.ts

## Context

The Agent Forge ATC (Air Traffic Controller) cron in `lib/atc.ts` currently dispatches work items that belong to projects, using a dependency graph (topological ordering) and project status checks to determine what's safe to dispatch next.

A new `source='direct'` work item type was recently added (see merged PRs: "feat: add 'direct' source type and 'triggeredBy' field to work item types" and "feat: handle direct-source items in dispatch logic and creation"). Direct-source items are filed by external callers (e.g., the Personal Assistant via `POST /api/work-items`) and are not part of any project. They have no parent project, no dependency graph, and no sibling coordination needed.

The ATC dispatch cycle currently does not handle `source='direct'` items — they get stuck in `filed`/`ready` status indefinitely because the dispatch logic only looks for project-affiliated items. This task wires direct items into the dispatch loop so they flow through the pipeline like project items, but with a simpler fast-path that skips all project/dependency logic.

Relevant type from `lib/types.ts`:
```typescript
// WorkItem.source can be: 'github' | 'notion' | 'manual' | 'direct' | 'project'
// WorkItem.status: 'filed' | 'ready' | 'queued' | 'generating' | 'executing' | 'reviewing' | 'merged' | 'blocked' | 'parked'
```

Per-repo concurrency limits are enforced in the ATC via `lib/repos.ts` — direct items must respect these same limits.

## Requirements

1. ATC dispatch cycle picks up work items with `source='direct'` that are in `'filed'` or `'ready'` status.
2. Direct items skip project parent lookup, project status checks, and dependency graph traversal entirely.
3. Per-repo concurrency limits (from `lib/repos.ts`) still apply to direct-source items just as they do to project items.
4. ATC logs `Dispatching direct item: {id}` (where `{id}` is the work item ID) for each direct item dispatched.
5. Existing project-source dispatch behavior is completely unchanged — no regression.
6. Direct items enter the same dispatch queue/flow as project items after the fast-path check.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/atc-dispatch-direct-source-items
```

### Step 1: Read existing ATC dispatch logic

Read `lib/atc.ts` in full before making any changes:
```bash
cat lib/atc.ts
```

Also read the supporting files for full context:
```bash
cat lib/work-items.ts
cat lib/repos.ts
cat lib/types.ts
```

Identify:
- The function/section in `lib/atc.ts` that determines what items are dispatchable (look for calls to `getNextDispatchable`, project status checks, concurrency checks, and dispatch invocations).
- How the ATC currently enforces per-repo concurrency limits (likely via active execution counts per repo).
- The shape of `WorkItem` — specifically `source`, `status`, `repoFullName`, and `id` fields.

### Step 2: Implement direct-source dispatch in `lib/atc.ts`

The implementation should follow this logic pattern. **Adapt it to match the actual structure you find in Step 1 — do not blindly copy-paste; fit it into the existing code style and flow.**

High-level change: In the ATC dispatch section (the part of the cron that decides which items to dispatch), add a block that:

1. **Queries for direct items** in `'filed'` or `'ready'` status with `source='direct'`.
2. **For each direct item**, checks if the item's target repo is under its concurrency limit.
3. **If under the limit**, dispatches the item and logs `Dispatching direct item: {id}`.
4. **If at the limit**, skips the item (same behavior as project items when concurrency is full).

Pseudocode sketch (adapt to actual patterns in the file):
```typescript
// --- Direct-source item dispatch ---
const directItems = allWorkItems.filter(
  (item) => item.source === 'direct' && (item.status === 'filed' || item.status === 'ready')
);

for (const item of directItems) {
  // Check per-repo concurrency limit
  const activeForRepo = activeExecutions.filter(
    (e) => e.repoFullName === item.repoFullName
  ).length;
  const repoConfig = await getRepoConfig(item.repoFullName); // use existing helper
  const limit = repoConfig?.concurrencyLimit ?? 1;

  if (activeForRepo >= limit) {
    console.log(`[ATC] Repo ${item.repoFullName} at concurrency limit, skipping direct item: ${item.id}`);
    continue;
  }

  console.log(`[ATC] Dispatching direct item: ${item.id}`);
  await dispatchWorkItem(item); // use same dispatch function as project items
}
```

Key constraints:
- Use the **same dispatch function** that project items use — do not duplicate dispatch logic.
- Use the **same concurrency check mechanism** that already exists for project items.
- Place the direct-item block **clearly separated** from the project-item dispatch block, with a comment header like `// --- Direct-source item dispatch ---`.
- Do not alter any existing project-dispatch code paths.

### Step 3: Verify no TypeScript errors

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues to watch for:
- `item.source` comparison — ensure `'direct'` is a valid value in the `WorkItem['source']` union type (it should be from the recent merged PR). If not, check `lib/types.ts` and add it if missing.
- Any `async/await` issues if the direct-item block is added inside a sync context.

### Step 4: Build check

```bash
npm run build
```

Resolve any build errors. Do not skip this step.

### Step 5: Manual review checklist

Before committing, verify the following by reading the diff:

- [ ] `source === 'direct'` check is present
- [ ] Both `'filed'` and `'ready'` statuses are included in the filter
- [ ] Per-repo concurrency limit check is applied to direct items
- [ ] Log line `Dispatching direct item: {id}` is present (with the actual item ID interpolated)
- [ ] No changes to the project-item dispatch code path
- [ ] No new dependencies imported (should reuse existing helpers)

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: dispatch direct-source work items in ATC cycle"
git push origin feat/atc-dispatch-direct-source-items
gh pr create \
  --title "feat: dispatch direct-source work items in ATC cycle" \
  --body "## Summary

Adds direct-source item dispatch to the ATC cron cycle.

## Changes
- \`lib/atc.ts\`: Added fast-path dispatch block for \`source='direct'\` items in \`filed\`/\`ready\` status. Direct items skip project parent lookup and dependency graph traversal, going straight to dispatch if the target repo is under its concurrency limit.

## Behavior
- Direct items are picked up each ATC cycle alongside project items
- Per-repo concurrency limits apply identically to direct and project items
- Logs emit \`[ATC] Dispatching direct item: {id}\` for observability
- Zero changes to existing project-source dispatch logic

## Testing
- TypeScript: \`npx tsc --noEmit\` passes
- Build: \`npm run build\` passes

## Acceptance Criteria
- [x] ATC dispatch cycle picks up \`source='direct'\` items in \`filed\`/\`ready\` status
- [x] Direct items skip project parent lookup and dependency graph checks
- [x] Per-repo concurrency limits still apply to direct items
- [x] ATC logs include direct source identification
- [x] Existing project-source dispatch behavior unchanged
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/atc-dispatch-direct-source-items
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed or is unresolved]
NEXT STEPS: [what remains]
```

If you encounter a blocker you cannot resolve (e.g., the `source='direct'` type is not present in `lib/types.ts` and adding it requires architectural decisions, or the ATC dispatch architecture is significantly different from what this handoff assumes), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "atc-dispatch-direct-source-items",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc.ts"]
    }
  }'
```