# Agent Forge -- ATC Section: Poll HLO State from Open PRs

## Metadata
- **Branch:** `feat/atc-poll-hlo-state`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/atc.ts

## Context

Agent Forge's Air Traffic Controller (ATC) runs on a Vercel cron and manages the work item pipeline. It is organized into numbered sections (§1, §2, §2.8, §3, §4, §4.5, §13, §13a, §13b, etc.) that each handle a distinct concern.

Recent merged PRs added two relevant GitHub helpers:
1. `getPRLifecycleState(owner, repo, prNumber)` — reads HLO lifecycle state from PR comments
2. `getCommitsBehindMain()` — not relevant here

The `HLOLifecycleState` type and `PRInfo` type were added in a recent PR adding "HLO state types and 'superseded' status to types.ts".

This task adds a new ATC section (§14) that polls HLO lifecycle state for all work items in `reviewing` status. The resulting map will be the foundation for future SLA/remediation sections.

### Relevant existing patterns in lib/atc.ts

The ATC file exports a main function (likely `runATC()` or similar) that calls section functions in order. Each section:
- Has a comment header like `// === §N: Section Title ===`
- Logs with a prefix like `ATC §N:`
- Returns data that may be passed to downstream sections

### Relevant types (from lib/types.ts)

```typescript
// WorkItem has: id, status ('reviewing' | others), prNumber?: number, repo, owner (or parsed from repoFullName)
// HLOLifecycleState — added recently, imported from lib/types.ts
// PRInfo — basic PR data structure
```

### Relevant function (from lib/github.ts)

```typescript
export async function getPRLifecycleState(
  owner: string,
  repo: string,
  prNumber: number
): Promise<HLOLifecycleState | null>
```

## Requirements

1. Add a new ATC section §14 (or next available number — check existing section numbers first) in `lib/atc.ts`
2. The section function iterates all work items with `status === 'reviewing'` that have a `prNumber` set
3. For each such work item, call `getPRLifecycleState(owner, repo, prNumber)` from `lib/github.ts`
4. Also fetch basic PR info (state, updated_at, head ref/branch) using the existing GitHub API helper in `lib/github.ts`
5. Collect results into a `Map<number, { workItem: WorkItem; hloState: HLOLifecycleState | null; prInfo: PRInfo | null }>` keyed by `prNumber`
6. Log a summary line: `ATC §14: Polled HLO state for N PRs (M with lifecycle data, K without)`
7. Handle null `hloState` gracefully — this is normal when a PR has no HLO lifecycle comment
8. The section must be called early in the main ATC cycle so downstream sections can use the returned map
9. Import `getPRLifecycleState` and `HLOLifecycleState` (and `PRInfo` if not already imported) in `lib/atc.ts`
10. `npm run build` passes with no TypeScript errors

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/atc-poll-hlo-state
```

### Step 1: Inspect existing code

Read the relevant files to understand current state before writing any code:

```bash
# Understand full ATC file structure, section numbering, imports, main function signature
cat lib/atc.ts

# Understand available exports from github.ts
grep -n "export" lib/github.ts | head -60

# Understand HLOLifecycleState and PRInfo types
grep -n "HLOLifecycleState\|PRInfo\|WorkItem" lib/types.ts | head -40

# Check what's already imported in atc.ts from github.ts
grep -n "github\|HLO\|PRInfo\|getPR" lib/atc.ts
```

### Step 2: Determine correct section number

```bash
# Find the highest existing section number
grep -n "§" lib/atc.ts | tail -20
```

Use the next available section number after the highest existing one. Based on the system map, §13b appears to be the last. Use §14 unless another section already uses that number.

### Step 3: Add imports to lib/atc.ts

At the top of `lib/atc.ts`, ensure these are imported from `lib/github.ts`:

```typescript
import { 
  // ... existing imports ...,
  getPRLifecycleState,
  // PRInfo if it comes from github.ts — check with grep first
} from './github'
```

And from `lib/types.ts`:
```typescript
import {
  // ... existing imports ...,
  HLOLifecycleState,
  // PRInfo if it comes from types.ts
} from './types'
```

**Important:** Before adding imports, run:
```bash
grep -n "getPRLifecycleState\|HLOLifecycleState\|PRInfo" lib/github.ts lib/types.ts
```
to confirm exactly which file exports each symbol.

### Step 4: Add the section function

Add the following section function to `lib/atc.ts`. Place it after the existing section functions but before the main ATC runner function. Adjust the section number and import paths based on what you found in Steps 1-3.

```typescript
// === §14: Poll HLO Lifecycle State from Open PRs ===
// Reads HLO lifecycle state for all work items in 'reviewing' status.
// Returns a map for downstream sections (SLA tracking, remediation, etc.)

export interface HLOStateEntry {
  workItem: WorkItem;
  hloState: HLOLifecycleState | null;
  prInfo: PRInfo | null;
}

async function pollHLOStateFromOpenPRs(
  workItems: WorkItem[]
): Promise<Map<number, HLOStateEntry>> {
  const reviewingItems = workItems.filter(
    (wi) => wi.status === 'reviewing' && wi.prNumber != null
  );

  const resultMap = new Map<number, HLOStateEntry>();

  await Promise.all(
    reviewingItems.map(async (wi) => {
      const prNumber = wi.prNumber!;
      
      // Parse owner/repo from work item
      // Work items store repo info — check the actual field names in WorkItem type
      const [owner, repo] = wi.repoFullName
        ? wi.repoFullName.split('/')
        : [wi.owner ?? '', wi.repo ?? ''];

      if (!owner || !repo) {
        console.warn(`ATC §14: Work item ${wi.id} missing owner/repo, skipping`);
        return;
      }

      let hloState: HLOLifecycleState | null = null;
      let prInfo: PRInfo | null = null;

      try {
        hloState = await getPRLifecycleState(owner, repo, prNumber);
      } catch (err) {
        console.warn(`ATC §14: Failed to get HLO state for PR #${prNumber}:`, err);
      }

      try {
        prInfo = await getPRInfo(owner, repo, prNumber);
      } catch (err) {
        console.warn(`ATC §14: Failed to get PR info for PR #${prNumber}:`, err);
      }

      resultMap.set(prNumber, { workItem: wi, hloState, prInfo });
    })
  );

  const withLifecycle = [...resultMap.values()].filter((e) => e.hloState !== null).length;
  const withoutLifecycle = resultMap.size - withLifecycle;

  console.log(
    `ATC §14: Polled HLO state for ${resultMap.size} PRs (${withLifecycle} with lifecycle data, ${withoutLifecycle} without)`
  );

  return resultMap;
}
```

**Important notes:**
- Check the actual field names on `WorkItem` for owner/repo — it may be `repoFullName`, `repo` (as `owner/repo`), or separate `owner`/`repo` fields. Adjust accordingly.
- Check if `getPRInfo` (or equivalent for fetching basic PR metadata) exists in `lib/github.ts`. If not, use the Octokit call pattern already present in the file, or fetch only the fields available. If there's no `getPRInfo` helper, inline the fetch or omit `prInfo` and only collect `hloState`. Do not create a new GitHub helper in this PR — that's out of scope.
- The `PRInfo` type — if it doesn't exist yet in `lib/types.ts` or `lib/github.ts`, define a minimal inline interface:
  ```typescript
  interface LocalPRInfo {
    state: string;
    updatedAt: string;
    headRef: string;
  }
  ```
  and use that in the map type instead.

### Step 5: Wire the section into the main ATC cycle

Find the main ATC runner function (likely `export async function runATC()` or similar). Add a call to `pollHLOStateFromOpenPRs` early in the cycle, after work items are fetched:

```typescript
// After fetching all work items (already done near top of runATC)
const allWorkItems = await listWorkItems(); // already present

// Add early in the cycle, before §2 or after initial setup:
const hloStateMap = await pollHLOStateFromOpenPRs(allWorkItems);
// hloStateMap is available for downstream sections in this same cycle
```

Look for the comment pattern like `// === §1:` or `// === §2:` to find the right insertion point. Place the §14 call after work items are loaded but before any remediation sections.

### Step 6: TypeScript check and build

```bash
npx tsc --noEmit
npm run build
```

Fix any type errors. Common issues to watch for:
- `PRInfo` type not exported — define locally if needed
- `WorkItem.prNumber` may be `number | undefined` — use non-null assertion only after the filter
- Owner/repo field names on `WorkItem` — check actual type definition

### Step 7: Verify the section is wired correctly

```bash
# Confirm the new section exists and is called
grep -n "§14\|pollHLOState\|hloStateMap" lib/atc.ts
```

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add ATC §14 to poll HLO lifecycle state from open PRs"
git push origin feat/atc-poll-hlo-state
gh pr create \
  --title "feat: add ATC §14 to poll HLO lifecycle state from open PRs" \
  --body "## Summary

Adds ATC §14: Poll HLO Lifecycle State from Open PRs.

This section iterates all work items in \`reviewing\` status, calls \`getPRLifecycleState()\` for each associated PR, and collects results into a \`Map<number, HLOStateEntry>\` keyed by PR number.

## Changes
- \`lib/atc.ts\`: Added §14 section function \`pollHLOStateFromOpenPRs()\`, wired into main ATC cycle
- Added imports for \`getPRLifecycleState\`, \`HLOLifecycleState\`, and related types

## Behavior
- Filters work items to those with \`status === 'reviewing'\` and \`prNumber != null\`
- Calls \`getPRLifecycleState()\` concurrently via \`Promise.all\`
- Handles null HLO state gracefully (normal when no lifecycle comment on PR)
- Handles fetch errors per-PR without crashing the section
- Logs: \`ATC §14: Polled HLO state for N PRs (M with lifecycle data, K without)\`
- Returns map available to downstream sections in same ATC cycle

## Testing
- \`npm run build\` passes
- TypeScript: no errors

## Acceptance Criteria
- [x] New ATC section iterates all \`reviewing\` work items and calls \`getPRLifecycleState\`
- [x] Returns map of prNumber → { workItem, hloState, prInfo }
- [x] Logs summary with counts
- [x] Handles null hloState gracefully
- [x] Build passes
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
BRANCH: feat/atc-poll-hlo-state
FILES CHANGED: lib/atc.ts
SUMMARY: [what was done]
ISSUES: [what failed or is incomplete]
NEXT STEPS: [what remains — e.g., "Need to wire pollHLOStateFromOpenPRs into main ATC cycle" or "PRInfo type not found, needs manual resolution"]
```

## Escalation

If blocked on any of the following, call the escalation API:
- `getPRLifecycleState` does not exist in `lib/github.ts` (the PR adding it may not have merged)
- `HLOLifecycleState` type is not exported from `lib/types.ts`
- The ATC main runner function signature is incompatible with passing a shared map between sections

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "atc-poll-hlo-state",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc.ts"]
    }
  }'
```