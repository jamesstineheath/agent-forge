# Agent Forge -- Add writeOutcomeSummary function to projects module

## Metadata
- **Branch:** `feat/write-outcome-summary`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/projects.ts

## Context

Agent Forge's `lib/projects.ts` manages project lifecycle transitions (Complete/Failed). When a project reaches a terminal state, it's valuable to write a structured outcome summary back to the originating Notion project page so stakeholders can see what shipped, what failed, and what remains.

The `appendPageContent` helper was recently added to `lib/notion.ts` (see recent merged PR). The `listWorkItems` function in `lib/work-items.ts` supports filtering. This task adds `writeOutcomeSummary` to `lib/projects.ts` that ties these together: fetch work items for the project, compute stats, format markdown, and append to the Notion page.

Key existing patterns in this codebase:
- `lib/projects.ts` already imports from `lib/work-items.ts` and `lib/notion.ts`
- Work items have fields: `id`, `title`, `status`, `projectId`, `repoName`, `prNumber`, `createdAt`, `updatedAt`, `budget`, and escalation-related fields
- `appendPageContent(projectPageId: string, markdown: string)` is available in `lib/notion.ts`
- Project objects have a `notionPageId` field used to identify the Notion page

## Requirements

1. Export `writeOutcomeSummary(projectId: string, status: 'Complete' | 'Failed'): Promise<void>` from `lib/projects.ts`
2. Function must fetch all work items filtered by `projectId` using `listWorkItems`
3. Compute stats: merged count, failed count, remaining count (items with status in `['ready', 'blocked', 'queued']`), total count, and estimated cost (sum of `budget` fields where present)
4. Compute duration from earliest `createdAt` to latest `updatedAt` among all work items; format as human-readable string (e.g., "3d 4h" or "2h 15m")
5. For `Complete` status: markdown must include `## Outcome Summary` header, status line, duration, work item counts, and `### Merged PRs` section listing each merged item as `repo#prNumber: title`
6. For `Failed` status: markdown must include `### What Shipped`, `### What Failed`, `### What Remains`, and `### Recovery Assessment` sections
7. Recovery Assessment logic: all failures from transient CI → `'Retry'`; any conflicts or plan issues → `'Re-plan'`; otherwise → `'Abandon'`
8. Call `appendPageContent(notionPageId, summaryMarkdown)` to write to Notion — must look up the project by `projectId` to get its `notionPageId`
9. Handle zero work items edge case: write a minimal summary noting no items were found
10. `npx tsc --noEmit` passes with no new type errors

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/write-outcome-summary
```

### Step 1: Inspect existing code

Read the relevant files to understand current types and APIs before writing any code:

```bash
cat lib/projects.ts
cat lib/work-items.ts
cat lib/notion.ts
cat lib/types.ts
```

Look for:
- How `listWorkItems` is called and what it returns (the `WorkItem` type shape)
- Fields available on `WorkItem`: especially `status`, `projectId`, `prNumber`, `repoName`, `budget`, `createdAt`, `updatedAt`, and any escalation/failure reason fields
- How `appendPageContent` is called in `lib/notion.ts`
- How projects are stored/fetched — find the function to get a project by `projectId` (likely `getProject` or `listProjects`)
- The `Project` type shape, especially the `notionPageId` field name

### Step 2: Implement `writeOutcomeSummary` in `lib/projects.ts`

Add the function at the bottom of `lib/projects.ts` (before any final exports if needed). Here is the full implementation to add — **adjust field names based on what you found in Step 1**:

```typescript
export async function writeOutcomeSummary(
  projectId: string,
  status: 'Complete' | 'Failed'
): Promise<void> {
  // Fetch the project to get notionPageId
  const project = await getProject(projectId); // use whatever getter exists
  if (!project?.notionPageId) {
    console.warn(`writeOutcomeSummary: no notionPageId for project ${projectId}, skipping`);
    return;
  }

  // Fetch all work items for this project
  const allItems = await listWorkItems();
  const items = allItems.filter((wi) => wi.projectId === projectId);

  // Edge case: no work items
  if (items.length === 0) {
    const minimalSummary = `## Outcome Summary\n\n**Status:** ${status}\n\n_No work items found for this project._\n`;
    await appendPageContent(project.notionPageId, minimalSummary);
    return;
  }

  // Compute stats
  const mergedItems = items.filter((wi) => wi.status === 'merged');
  const failedItems = items.filter((wi) => wi.status === 'failed');
  const remainingItems = items.filter((wi) =>
    ['ready', 'blocked', 'queued'].includes(wi.status)
  );
  const cancelledItems = items.filter((wi) => wi.status === 'cancelled');

  const totalCount = items.length;
  const estimatedCost = items.reduce((sum, wi) => sum + (wi.budget ?? 0), 0);

  // Compute duration
  const timestamps = items.flatMap((wi) => [
    wi.createdAt ? new Date(wi.createdAt).getTime() : null,
    wi.updatedAt ? new Date(wi.updatedAt).getTime() : null,
  ]).filter((t): t is number => t !== null);

  let durationStr = 'unknown';
  if (timestamps.length >= 2) {
    const earliest = Math.min(...timestamps);
    const latest = Math.max(...timestamps);
    const diffMs = latest - earliest;
    const diffMinutes = Math.floor(diffMs / 60000);
    const days = Math.floor(diffMinutes / 1440);
    const hours = Math.floor((diffMinutes % 1440) / 60);
    const minutes = diffMinutes % 60;
    if (days > 0) {
      durationStr = `${days}d ${hours}h`;
    } else if (hours > 0) {
      durationStr = `${hours}h ${minutes}m`;
    } else {
      durationStr = `${minutes}m`;
    }
  }

  let summaryMarkdown: string;

  if (status === 'Complete') {
    const mergedPRLines = mergedItems.map((wi) => {
      const prRef = wi.prNumber ? `${wi.repoName ?? 'unknown'}#${wi.prNumber}` : '(no PR)';
      return `- ${prRef}: ${wi.title}`;
    });

    const notesLines: string[] = [];
    if (cancelledItems.length > 0) {
      notesLines.push(`- ${cancelledItems.length} item(s) were cancelled: ${cancelledItems.map((wi) => wi.title).join(', ')}`);
    }

    summaryMarkdown = [
      `## Outcome Summary`,
      ``,
      `**Status:** ${status}`,
      `**Duration:** ${durationStr}`,
      `**Total Work Items:** ${totalCount}`,
      `**Merged:** ${mergedItems.length}`,
      `**Failed:** ${failedItems.length}`,
      `**Remaining:** ${remainingItems.length}`,
      `**Estimated Cost:** $${estimatedCost.toFixed(2)}`,
      ``,
      `### Merged PRs`,
      ``,
      mergedPRLines.length > 0 ? mergedPRLines.join('\n') : '_No merged PRs._',
      ``,
      `### Notes`,
      ``,
      notesLines.length > 0 ? notesLines.join('\n') : '_No additional notes._',
      ``,
    ].join('\n');
  } else {
    // Failed status
    const shippedLines = mergedItems.map((wi) => {
      const prRef = wi.prNumber ? `${wi.repoName ?? 'unknown'}#${wi.prNumber}` : '(no PR)';
      return `- ${prRef}: ${wi.title}`;
    });

    const failedLines = failedItems.map((wi) => {
      // Use escalation reason or a generic fallback — adjust field name as needed
      const reason = (wi as any).escalationReason ?? (wi as any).failureReason ?? 'No failure context recorded';
      return `- **${wi.title}**: ${reason}`;
    });

    const remainingLines = remainingItems.map((wi) => `- ${wi.title} _(${wi.status})_`);

    // Recovery Assessment logic
    const failureReasons = failedItems.map((wi) =>
      ((wi as any).escalationReason ?? (wi as any).failureReason ?? '').toLowerCase()
    );

    const transitientKeywords = ['ci', 'timeout', 'flak', 'network', 'rate limit', 'transient'];
    const conflictKeywords = ['conflict', 'plan', 'merge conflict', 'design', 'dependency'];

    const allTransient = failureReasons.every((r) =>
      transitientKeywords.some((kw) => r.includes(kw))
    );
    const anyConflict = failureReasons.some((r) =>
      conflictKeywords.some((kw) => r.includes(kw))
    );

    let retryable: string;
    let reason: string;
    let recommendation: string;

    if (failedItems.length === 0) {
      retryable = 'N/A';
      reason = 'No failures recorded';
      recommendation = 'Review remaining items manually';
    } else if (allTransient) {
      retryable = 'Yes';
      reason = 'All failures appear to be transient CI/infrastructure issues';
      recommendation = 'Retry';
    } else if (anyConflict) {
      retryable = 'Partial';
      reason = 'Some failures involve conflicts or plan-level issues';
      recommendation = 'Re-plan';
    } else {
      retryable = 'No';
      reason = 'Failures do not match known transient patterns';
      recommendation = 'Abandon';
    }

    summaryMarkdown = [
      `## Outcome Summary`,
      ``,
      `**Status:** ${status}`,
      `**Duration:** ${durationStr}`,
      `**Total Work Items:** ${totalCount}`,
      `**Merged:** ${mergedItems.length}`,
      `**Failed:** ${failedItems.length}`,
      `**Remaining:** ${remainingItems.length}`,
      `**Estimated Cost:** $${estimatedCost.toFixed(2)}`,
      ``,
      `### What Shipped`,
      ``,
      shippedLines.length > 0 ? shippedLines.join('\n') : '_Nothing shipped._',
      ``,
      `### What Failed`,
      ``,
      failedLines.length > 0 ? failedLines.join('\n') : '_No failures recorded._',
      ``,
      `### What Remains`,
      ``,
      remainingLines.length > 0 ? remainingLines.join('\n') : '_Nothing remaining._',
      ``,
      `### Recovery Assessment`,
      ``,
      `**Retryable:** ${retryable}`,
      `**Reason:** ${reason}`,
      `**Recommendation:** ${recommendation}`,
      ``,
    ].join('\n');
  }

  await appendPageContent(project.notionPageId, summaryMarkdown);
}
```

**Important:** After reading the existing code in Step 1, adjust:
- The project getter function name (e.g., `getProject`, `getProjectById`, or find it via `listProjects` + filter)
- The `notionPageId` field name on the `Project` type (it might be `notionPageId`, `pageId`, or similar)
- The `WorkItem` field names for `budget`, `repoName`, `prNumber`, `createdAt`, `updatedAt`
- Any failure reason fields on `WorkItem` (may be `escalationReason`, `failureReason`, or may need to be cast)
- Make sure all necessary imports are at the top of the file: `listWorkItems` from `./work-items`, `appendPageContent` from `./notion`

### Step 3: Add missing imports

At the top of `lib/projects.ts`, ensure these imports are present (add only what's missing):

```typescript
import { listWorkItems } from './work-items';
import { appendPageContent } from './notion';
```

### Step 4: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues to watch for:
- If `WorkItem` type doesn't have `escalationReason`/`failureReason`, cast with `(wi as any).fieldName` or use optional chaining
- If `budget` is typed as `string` rather than `number`, parse it: `parseFloat(wi.budget ?? '0')`
- If `listWorkItems` returns a different shape (e.g., paginated), unwrap accordingly

### Step 5: Final verification

```bash
npx tsc --noEmit
npm run build 2>&1 | head -50
```

Confirm no type errors and build succeeds (or only has pre-existing errors unrelated to this change).

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add writeOutcomeSummary to projects module"
git push origin feat/write-outcome-summary
gh pr create \
  --title "feat: add writeOutcomeSummary to projects module" \
  --body "## Summary

Adds \`writeOutcomeSummary(projectId, status)\` to \`lib/projects.ts\`.

## What this does
- Fetches all work items for a project via \`listWorkItems\`
- Computes stats: merged/failed/remaining counts, estimated cost, duration
- For **Complete** projects: generates markdown with Outcome Summary, Merged PRs list, and Notes
- For **Failed** projects: generates What Shipped / What Failed / What Remains / Recovery Assessment sections
- Recovery Assessment: Retry (transient CI), Re-plan (conflicts/plan issues), Abandon (otherwise)
- Calls \`appendPageContent\` to write the summary to the Notion project page
- Handles zero work items edge case with a minimal summary

## Files changed
- \`lib/projects.ts\` — added \`writeOutcomeSummary\` function + necessary imports

## Testing
- \`npx tsc --noEmit\` passes with no new type errors"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/write-outcome-summary
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If you encounter a blocker you cannot resolve autonomously (e.g., `appendPageContent` has a different signature than expected, `WorkItem` type is missing critical fields, or the project getter doesn't exist), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "write-outcome-summary",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/projects.ts"]
    }
  }'
```