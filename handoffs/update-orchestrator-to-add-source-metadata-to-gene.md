# Agent Forge -- Update Orchestrator to add source metadata to generated handoffs

## Metadata
- **Branch:** `feat/orchestrator-source-metadata`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/orchestrator.ts

## Context

The Orchestrator (`lib/orchestrator.ts`) generates handoff files for work items and dispatches them to target repos. Work items can come from multiple sources, including `source='project'` (from Notion plan decomposition) and `source='direct'` (filed directly via the PA bridge or MCP endpoint).

The Spec Reviewer TLM agent needs to know the source of a handoff file so it can apply the appropriate review mode. The convention is HTML comments at the top of the handoff file:
- `<!-- source: direct -->` — indicates this handoff was generated for a direct-source item
- `<!-- triggeredBy: {value} -->` — who/what triggered the work item (e.g., `pa-bridge`, `mcp`)
- `<!-- budget: {value} -->` — the budget allocated for the work item

Currently, the Orchestrator does not inject these metadata comments. This task adds that injection for `source='direct'` items, while leaving project-source handoff generation unchanged.

The `WorkItem` type in `lib/types.ts` already has `source`, `triggeredBy`, and `complexityHint` (or `budget`) fields — check the actual field names when reading the file.

## Requirements

1. When generating a handoff for a work item with `source='direct'`, inject the following HTML comment block at the very top of the generated handoff markdown (before the `#` title line):
   ```
   <!-- source: direct -->
   <!-- triggeredBy: {workItem.triggeredBy or 'unknown'} -->
   <!-- budget: {workItem.budget or workItem.complexityHint or '5'} -->
   ```
2. The metadata block must appear before the `# Title` heading in the handoff file.
3. Direct-source handoff generation must use the same repo context gathering as project items: read `CLAUDE.md`, `SYSTEM_MAP.md`, and recent file tree from the target repo via GitHub API.
4. Existing handoff generation for `source='project'` items must be unchanged (no metadata injected, no behavioral change).
5. If `triggeredBy` is absent/undefined on the work item, default to `'unknown'`.
6. If budget/complexityHint is absent/undefined, default to `'5'`.
7. TypeScript must compile with no new errors (`npx tsc --noEmit`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/orchestrator-source-metadata
```

### Step 1: Read and understand the existing orchestrator

Read the full orchestrator file to understand the current handoff generation logic:

```bash
cat lib/orchestrator.ts
```

Also read the types to understand the `WorkItem` shape:
```bash
cat lib/types.ts
```

Look for:
- The function(s) responsible for generating the handoff markdown string
- How the work item fields are accessed (especially `source`, `triggeredBy`, `budget`, `complexityHint`)
- Where the repo context (CLAUDE.md, SYSTEM_MAP) is fetched
- Whether direct-source items already have a separate code path or share the same path as project items

### Step 2: Identify the handoff generation function

In `lib/orchestrator.ts`, locate the function that assembles the final handoff markdown string (it likely builds a string with the `# Title`, `## Metadata`, `## Context`, `## Requirements`, etc. sections).

There may be:
- A single generation path used for all items
- Separate paths for `source='direct'` vs `source='project'`

In either case, the goal is: **for `source='direct'` items only**, prepend the metadata comment block to the generated handoff string.

### Step 3: Implement the metadata injection

Find where the handoff content string is assembled. Add a helper that builds the metadata comment block:

```typescript
function buildDirectSourceMetadata(workItem: WorkItem): string {
  const triggeredBy = workItem.triggeredBy ?? 'unknown';
  // Use whichever budget field exists on WorkItem — check types.ts for the real field name
  const budget = (workItem as any).budget ?? (workItem as any).complexityHint ?? '5';
  return `<!-- source: direct -->\n<!-- triggeredBy: ${triggeredBy} -->\n<!-- budget: ${budget} -->\n\n`;
}
```

Then, in the handoff assembly logic, prepend this metadata for direct-source items:

```typescript
let handoffContent = assembleHandoff(workItem, repoContext); // existing logic

if (workItem.source === 'direct') {
  handoffContent = buildDirectSourceMetadata(workItem) + handoffContent;
}
```

Adjust to match the actual variable names and function structure you find in the file.

### Step 4: Ensure direct-source items use full repo context

Verify that when `source='direct'` items reach handoff generation, they go through the same repo context gathering (GitHub API reads for `CLAUDE.md`, `SYSTEM_MAP.md`, file tree) as project items.

If there's a shortcut path for direct items that skips context gathering, remove it so both paths call the same context-fetching logic before generating the handoff.

If both paths already share context gathering, no change is needed here.

### Step 5: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors introduced by the changes. If `WorkItem` doesn't have a `budget` field explicitly, use optional chaining or a type assertion (document with a comment why).

### Step 6: Manual inspection check

Run a quick sanity check by tracing through the logic mentally (or with a test if the repo has tests):

1. Simulate a `WorkItem` with `source='direct'`, `triggeredBy='pa-bridge'`, and a budget value.
2. Verify the generated handoff would start with:
   ```
   <!-- source: direct -->
   <!-- triggeredBy: pa-bridge -->
   <!-- budget: 5 -->
   
   # My Work Item Title
   ...
   ```
3. Simulate a `WorkItem` with `source='project'` and verify no metadata comment is added.

### Step 7: Build check

```bash
npm run build
```

Resolve any build errors before proceeding.

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: inject source metadata comments into direct-source handoffs"
git push origin feat/orchestrator-source-metadata
gh pr create \
  --title "feat: inject source metadata into direct-source generated handoffs" \
  --body "## Summary

Modifies the Orchestrator to prepend HTML metadata comments to handoff files generated for \`source='direct'\` work items.

## Changes

- \`lib/orchestrator.ts\`: Added \`buildDirectSourceMetadata()\` helper and metadata injection in handoff assembly for direct-source items.

## Metadata format injected

\`\`\`
<!-- source: direct -->
<!-- triggeredBy: {value|'unknown'} -->
<!-- budget: {value|'5'} -->
\`\`\`

## Behavior

- Direct-source items: metadata block prepended to handoff
- Project-source items: no change
- Direct-source items use same repo context gathering (CLAUDE.md, SYSTEM_MAP) as project items

## Testing

- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- Traced through both code paths manually to verify correct behavior
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/orchestrator-source-metadata
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If you encounter an unresolvable blocker (e.g., the WorkItem type structure is fundamentally different from what's described, or the orchestrator uses a code generation approach that makes metadata injection non-trivial), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "orchestrator-source-metadata",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/orchestrator.ts"]
    }
  }'
```