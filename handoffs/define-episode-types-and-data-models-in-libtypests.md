# Agent Forge -- Define Episode types and data models in lib/types.ts

## Metadata
- **Branch:** `feat/episode-types`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/types.ts

## Context

Agent Forge is a dev orchestration platform (Next.js on Vercel) that coordinates autonomous agent teams. The `lib/types.ts` file is the central type definition module for the control plane, containing `WorkItem`, `Project`, and other shared types.

This task introduces Episode-related TypeScript interfaces to support an episodic memory system — a foundational feature that will allow the platform to record and retrieve past task experiences. These types are depended upon by all other Episode-related work items, so correctness and completeness are critical.

The existing `WorkItem` type in `lib/types.ts` needs an optional `episodeAttribution` field added to it, linking work items to the episodes that informed them.

## Requirements

1. Export an `Episode` interface from `lib/types.ts` with all fields: `id: string`, `taskDescription: string`, `approach: string`, `outcome: 'success' | 'failure' | 'partial'`, `outcomeDetail: string`, `insights: string[]`, `repoSlug: string`, `workItemId?: string`, `projectId?: string`, `tags: string[]`, `filesChanged: string[]`, `embedding: number[]`, `createdAt: string`, `updatedAt: string`
2. Export an `EpisodeRetrievalResult` interface from `lib/types.ts` with fields: `episode: Episode`, `similarityScore: number`
3. Export an `EpisodeAttribution` interface from `lib/types.ts` with fields: `episodeId: string`, `similarityScore: number`, `influenceNote: string`
4. Export an `EpisodeSearchParams` interface from `lib/types.ts` with fields: `query?: string`, `fromDate?: string`, `toDate?: string`, `outcome?: 'success' | 'failure' | 'partial'`, `cursor?: string`, `limit?: number`
5. Add `episodeAttribution?: EpisodeAttribution[]` as an optional field on the existing `WorkItem` type
6. `npm run build` passes with no TypeScript errors
7. Existing tests continue to pass

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/episode-types
```

### Step 1: Inspect current lib/types.ts

Read the existing file carefully to understand the current `WorkItem` type structure and where to safely insert new types.

```bash
cat lib/types.ts
```

### Step 2: Add Episode types to lib/types.ts

Locate the `WorkItem` type/interface in `lib/types.ts`. Add the new Episode-related interfaces near the bottom of the file (before any closing exports if applicable), and add the optional `episodeAttribution` field to `WorkItem`.

**New interfaces to add** (insert as a cohesive block, ideally grouped together with a comment):

```typescript
// ---------------------------------------------------------------------------
// Episode Memory Types
// ---------------------------------------------------------------------------

export interface Episode {
  id: string;
  taskDescription: string;
  approach: string;
  outcome: 'success' | 'failure' | 'partial';
  outcomeDetail: string;
  insights: string[];
  repoSlug: string;
  workItemId?: string;
  projectId?: string;
  tags: string[];
  filesChanged: string[];
  embedding: number[];
  createdAt: string;
  updatedAt: string;
}

export interface EpisodeRetrievalResult {
  episode: Episode;
  similarityScore: number;
}

export interface EpisodeAttribution {
  episodeId: string;
  similarityScore: number;
  influenceNote: string;
}

export interface EpisodeSearchParams {
  query?: string;
  fromDate?: string;
  toDate?: string;
  outcome?: 'success' | 'failure' | 'partial';
  cursor?: string;
  limit?: number;
}
```

**Modification to WorkItem** — find the existing `WorkItem` type or interface and add this optional field to it:

```typescript
episodeAttribution?: EpisodeAttribution[];
```

Make sure `EpisodeAttribution` is defined before it is referenced in `WorkItem`, or TypeScript will complain about forward references (move the block above `WorkItem` if needed, or place it after `WorkItem` and use a forward reference — the safest approach is to place Episode types *before* `WorkItem` in the file if `WorkItem` references `EpisodeAttribution`, or *after* `WorkItem` if only `WorkItem` references it via optional field — since TypeScript interfaces are hoisted in the same file, either order works, but placing before `WorkItem` is cleaner).

**Recommended placement strategy:**
1. If `WorkItem` is defined as an `interface`, add `episodeAttribution?: EpisodeAttribution[]` inside the interface body.
2. If `WorkItem` is defined as a `type` alias, add `episodeAttribution?: EpisodeAttribution[]` inside the object literal.
3. Place the Episode interfaces block *before* the `WorkItem` definition in the file for clarity.

### Step 3: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

If there are errors related to `EpisodeAttribution` being used before it is declared, move the Episode interfaces block above the `WorkItem` definition.

### Step 4: Run build

```bash
npm run build
```

Resolve any errors before proceeding. If there are pre-existing build errors unrelated to this change, note them but do not attempt to fix them — only fix errors introduced by this PR.

### Step 5: Run tests

```bash
npm test
```

If no test command is configured, verify with:

```bash
cat package.json | grep -A5 '"scripts"'
```

If tests don't exist or aren't configured, note this in the PR description but do not fail the task.

### Step 6: Verification
```bash
npx tsc --noEmit
npm run build
```

### Step 7: Commit, push, open PR
```bash
git add lib/types.ts
git commit -m "feat: add Episode types and data models to lib/types.ts"
git push origin feat/episode-types
gh pr create \
  --title "feat: add Episode types and data models to lib/types.ts" \
  --body "## Summary

Adds foundational Episode-related TypeScript interfaces to \`lib/types.ts\` to support an episodic memory system.

## Changes

- Added \`Episode\` interface with all required fields (id, taskDescription, approach, outcome, outcomeDetail, insights, repoSlug, workItemId, projectId, tags, filesChanged, embedding, createdAt, updatedAt)
- Added \`EpisodeRetrievalResult\` interface
- Added \`EpisodeAttribution\` interface
- Added \`EpisodeSearchParams\` interface
- Added optional \`episodeAttribution?: EpisodeAttribution[]\` field to existing \`WorkItem\` type

## Acceptance Criteria

- [x] All four Episode interfaces exported from lib/types.ts
- [x] WorkItem includes optional episodeAttribution field
- [x] npm run build passes with no type errors
- [x] Existing tests continue to pass

## Risk

Low — additive changes only. No existing fields modified, no existing types removed."
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/episode-types
FILES CHANGED: [lib/types.ts]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If you encounter a blocker you cannot resolve (e.g., `WorkItem` type has a structure that makes adding `EpisodeAttribution` impossible without breaking existing consumers, or the file uses a pattern that requires architectural decisions):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "episode-types",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/types.ts"]
    }
  }'
```