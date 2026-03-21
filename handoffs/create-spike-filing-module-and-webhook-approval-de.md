# Agent Forge -- Create spike filing module and webhook approval detection

## Metadata
- **Branch:** `feat/spike-filing-webhook-approval`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/spike-filing.ts, app/api/webhooks/github/route.ts

## Context

Agent Forge has a spike handoff system for generating and executing technical investigation work items. The PM Agent can recommend spikes when it detects uncertainty in a project (see `lib/pm-agent.ts`, `lib/spike-handoff.ts`). There's also a spike completion handler (`lib/spike-completion.ts`) that processes post-execution spike results.

The missing piece is: (1) a module to actually **file** spike work items into the work-items store, and (2) webhook-based **approval detection** so that when a human replies to a spike recommendation comment with approval keywords or adds a thumbs_up reaction, the system automatically files the spike.

### Relevant existing patterns

**Work item creation** (`lib/work-items.ts`): The store has a `createWorkItem(item)` function accepting a `WorkItem` shape. Work items have a `type` field and a `metadata` field (JSONB in Postgres). Look at how existing work items are created for the correct field set.

**Spike metadata** (`lib/types.ts`): The `WorkItem` type includes optional `spikeMetadata` with fields like `technicalQuestion`, `scope`, `recommendedBy`. Check `lib/types.ts` for the exact shape.

**Webhook handler** (`app/api/webhooks/github/route.ts`): Currently handles `issue_comment`, `pull_request_review_comment`, `pull_request`, `push`, and `reaction` event types. Events are HMAC-SHA256 verified via `X-Hub-Signature-256`. The handler logs to the event bus and may forward to other subsystems.

**Spike recommendation comments**: The PM Agent generates spike recommendations as GitHub comments on PRD-related issues/PRs. These need a marker string `<!-- spike-recommendation -->` added to their template so the webhook can identify them.

**Spike handoff generator** (`lib/spike-handoff.ts`): Existing module that generates the handoff markdown for executing a spike. `fileSpikeWorkItem` should be called before this (to register the item) or independently.

### Recent patterns to follow
- `lib/spike-completion.ts` for how spike-related modules are structured
- `lib/escalation.ts` for how work items are created programmatically with metadata
- Event bus logging pattern: `appendEvent({ type, payload, timestamp })` from `lib/atc/events.ts`

## Requirements

1. `lib/spike-filing.ts` must export a `fileSpikeWorkItem(params: { prdId: string; technicalQuestion: string; scope: string; recommendedBy: 'pm-agent' | 'manual' }): Promise<WorkItem>` function
2. `fileSpikeWorkItem()` must create a work item with `type: 'spike'` and populate `spikeMetadata` with the provided params
3. The work item must have a descriptive `title` derived from `technicalQuestion` (e.g., `"Spike: ${technicalQuestion.slice(0, 80)}"`) and `status: 'ready'`
4. The webhook handler must detect a `issue_comment.created` event where the comment body contains any of the approval keywords: `approve spike`, `yes`, `go ahead`, `+1` (case-insensitive), and the comment is a **reply** on an issue/PR whose thread contains a comment with the marker `<!-- spike-recommendation -->`
5. The webhook handler must detect a `pull_request_review_comment` reaction event (or `reaction.created` on `issue_comment`) with `reaction.content === '+1'` or `reaction.content === 'heart'` where the reacted-to comment body contains `<!-- spike-recommendation -->`
6. When approval is detected, the webhook handler must parse the spike recommendation comment body to extract `technicalQuestion` (from a `**Technical Question:**` line) and `scope` (from a `**Scope:**` line), then call `fileSpikeWorkItem()`
7. Spike recommendation comments are identified by the marker string `<!-- spike-recommendation -->` present in their body
8. The `prdId` for filed spikes should be derived from the issue/PR number (e.g., `"gh-issue-${issueNumber}"`)
9. TypeScript compiles without errors (`npx tsc --noEmit`)
10. No existing webhook handler functionality is broken

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/spike-filing-webhook-approval
```

### Step 1: Inspect existing types and work-item creation patterns

Read the following files carefully before writing any code:

```bash
cat lib/types.ts
cat lib/work-items.ts
cat lib/spike-handoff.ts
cat lib/spike-completion.ts
cat app/api/webhooks/github/route.ts
cat lib/atc/events.ts
```

Key things to confirm:
- The exact shape of `WorkItem` and `spikeMetadata` in `lib/types.ts`
- The function signature of `createWorkItem` (or equivalent) in `lib/work-items.ts`
- How `recommendedBy` is typed in `spikeMetadata` (may already exist or need adding)
- What event types the webhook handler already handles and how it's structured

### Step 2: Update types if needed

Open `lib/types.ts`. If `spikeMetadata` does not already exist on `WorkItem`, add it. If it exists but is missing fields, extend it. The shape should be:

```typescript
spikeMetadata?: {
  prdId: string;
  technicalQuestion: string;
  scope: string;
  recommendedBy: 'pm-agent' | 'manual';
};
```

If `WorkItem` already has this shape (likely given recent PRs), skip this step. Do not add duplicates.

### Step 3: Create lib/spike-filing.ts

Create `lib/spike-filing.ts`:

```typescript
/**
 * lib/spike-filing.ts
 *
 * Files spike work items into the work-items store.
 * Called when a human approves a spike recommendation (via webhook)
 * or when the PM Agent programmatically files a spike.
 */

import { createWorkItem } from './work-items';
import { WorkItem } from './types';
import { appendEvent } from './atc/events';

export interface FileSpikeParams {
  prdId: string;
  technicalQuestion: string;
  scope: string;
  recommendedBy: 'pm-agent' | 'manual';
}

export async function fileSpikeWorkItem(params: FileSpikeParams): Promise<WorkItem> {
  const { prdId, technicalQuestion, scope, recommendedBy } = params;

  const title = `Spike: ${technicalQuestion.slice(0, 80)}${technicalQuestion.length > 80 ? '...' : ''}`;

  const workItem = await createWorkItem({
    title,
    description: `Technical spike to investigate: ${technicalQuestion}\n\nScope: ${scope}\n\nSource PRD: ${prdId}`,
    type: 'spike',
    status: 'ready',
    priority: 'medium',
    spikeMetadata: {
      prdId,
      technicalQuestion,
      scope,
      recommendedBy,
    },
  });

  await appendEvent({
    type: 'spike_filed',
    payload: {
      workItemId: workItem.id,
      prdId,
      technicalQuestion,
      scope,
      recommendedBy,
    },
    timestamp: new Date().toISOString(),
  });

  return workItem;
}
```

**Important:** Adjust the `createWorkItem` call signature to match exactly what `lib/work-items.ts` exports. If it takes a different shape (e.g., no `type` field at the top level, or `metadata` is a separate JSONB field), adapt accordingly. Check if `spikeMetadata` is stored as a top-level field or inside a `metadata` object.

Also check `appendEvent`'s signature — it may take a different shape. Look at how `lib/atc/events.ts` exports it and match that pattern exactly.

### Step 4: Modify app/api/webhooks/github/route.ts

The webhook handler needs two new detection paths. Add them carefully without breaking existing handling.

**4a. Identify where to add the new logic**

Read the file and find where event types are dispatched. There will likely be a switch/if-else on the `X-GitHub-Event` header or a `eventType` variable. You need to add handling for:
- `issue_comment` events (already handled? extend it)
- `reaction` events (may be new — `issue_comment_reaction` or just `reaction`)

**4b. Add helper functions** (add near the top of the file, after imports):

```typescript
// --- Spike approval detection helpers ---

const SPIKE_RECOMMENDATION_MARKER = '<!-- spike-recommendation -->';

const APPROVAL_KEYWORDS = ['approve spike', 'yes', 'go ahead', '+1'];

function isApprovalComment(body: string): boolean {
  const lower = body.toLowerCase().trim();
  return APPROVAL_KEYWORDS.some((kw) => lower.includes(kw));
}

function isSpikeRecommendationComment(body: string): boolean {
  return body.includes(SPIKE_RECOMMENDATION_MARKER);
}

/**
 * Parses a spike recommendation comment body.
 * Expects lines like:
 *   **Technical Question:** What is the best approach for X?
 *   **Scope:** 2-4 hours
 */
function parseSpikeRecommendation(body: string): { technicalQuestion: string; scope: string } | null {
  const tqMatch = body.match(/\*\*Technical Question:\*\*\s*(.+)/i);
  const scopeMatch = body.match(/\*\*Scope:\*\*\s*(.+)/i);

  if (!tqMatch || !scopeMatch) return null;

  return {
    technicalQuestion: tqMatch[1].trim(),
    scope: scopeMatch[1].trim(),
  };
}

async function handleSpikeApproval(params: {
  issueNumber: number;
  repoFullName: string;
  recommendationCommentBody: string;
}): Promise<void> {
  const { issueNumber, repoFullName, recommendationCommentBody } = params;

  const parsed = parseSpikeRecommendation(recommendationCommentBody);
  if (!parsed) {
    console.warn('[webhook] Could not parse spike recommendation comment, skipping filing');
    return;
  }

  const prdId = `gh-issue-${issueNumber}`;

  try {
    const workItem = await fileSpikeWorkItem({
      prdId,
      technicalQuestion: parsed.technicalQuestion,
      scope: parsed.scope,
      recommendedBy: 'manual',
    });
    console.log(`[webhook] Spike work item filed: ${workItem.id} for issue #${issueNumber} in ${repoFullName}`);
  } catch (err) {
    console.error('[webhook] Failed to file spike work item:', err);
  }
}
```

**4c. Add import** at the top of the file:

```typescript
import { fileSpikeWorkItem } from '@/lib/spike-filing';
```

(Use the correct import path — `@/lib/spike-filing` or `../../lib/spike-filing` depending on tsconfig paths.)

**4d. Add issue_comment approval detection**

Inside the event handler, find or add handling for `issue_comment` event type. When `action === 'created'`, after existing logic, add:

```typescript
// Spike approval detection via reply comment
if (
  eventType === 'issue_comment' &&
  payload.action === 'created' &&
  payload.comment?.body &&
  isApprovalComment(payload.comment.body)
) {
  // We need to check if the issue/PR has a spike recommendation comment.
  // To avoid GitHub API calls on every comment, only proceed if the commenter
  // is not a bot and the issue number is present.
  const issueNumber: number | undefined = payload.issue?.number;
  const repoFullName: string | undefined = payload.repository?.full_name;

  if (issueNumber && repoFullName) {
    // Fetch comments on this issue to find the spike recommendation
    try {
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: process.env.GH_PAT });
      const [owner, repo] = repoFullName.split('/');

      const { data: comments } = await octokit.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
      });

      const spikeComment = comments.find((c) => isSpikeRecommendationComment(c.body ?? ''));
      if (spikeComment?.body) {
        await handleSpikeApproval({
          issueNumber,
          repoFullName,
          recommendationCommentBody: spikeComment.body,
        });
      }
    } catch (err) {
      console.error('[webhook] Error fetching issue comments for spike detection:', err);
    }
  }
}
```

**Note:** Check how GitHub API calls are already made in this file. If there's an existing `octokit` instance or a wrapper from `lib/github.ts`, use that pattern instead of instantiating a new Octokit. Match the existing style exactly.

**4e. Add reaction-based approval detection**

GitHub sends `pull_request_review_comment` reactions and `issue_comment` reactions as separate webhook event types. The event type header will be `issue_comment` with action `created` for reactions... actually GitHub sends a distinct event. Check the GitHub docs pattern used in the codebase.

Add handling for the `reaction` or `issue_comment` reaction event. The GitHub event type for a reaction on an issue comment is sent as event type `issue_comment` with action... actually GitHub sends it as event header `issue_comment` but reaction webhooks come through a separate event. Look at the existing webhook handler carefully to see how `X-GitHub-Event` is used.

Add this block (adapt to match existing event dispatch pattern):

```typescript
// Spike approval via thumbs_up or heart reaction on a spike recommendation comment
if (
  eventType === 'issue_comment' &&
  payload.action === 'created' &&
  payload.reaction // GitHub sends reactions differently -- check actual payload structure
) {
  // This path may actually come as a separate event type depending on GitHub config
  // See: https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment
}

// More likely: reactions come as a dedicated webhook event type
// GitHub event header: "issue_comment" with action "created" for comment reactions
// OR as event type depends on webhook config. Check existing handler.
// 
// Safe fallback: handle `payload.action === 'created'` and `payload.reaction` being present
// as the reaction webhook sends event type matching the subject (issue_comment for comment reactions)
```

**The safest approach**: Look at how GitHub delivers `pull_request_review_comment` reactions in the existing handler. If there's no existing reaction handling, add a dedicated block:

```typescript
// Reaction-based spike approval
// GitHub sends: X-GitHub-Event: issue_comment_reaction (or just checks payload shape)
// Actually GitHub uses event type from the webhook config -- inspect existing patterns.
// 
// Add this check inside the existing issue_comment or reaction handler:
if (
  (eventType === 'issue_comment_reaction' || 
   (eventType === 'reaction' && payload.subject_type === 'comment')) &&
  payload.action === 'created' &&
  (payload.reaction?.content === '+1' || payload.reaction?.content === 'heart')
) {
  const commentBody: string | undefined = payload.comment?.body;
  const issueNumber: number | undefined = payload.issue?.number ?? payload.pull_request?.number;
  const repoFullName: string | undefined = payload.repository?.full_name;

  if (commentBody && isSpikeRecommendationComment(commentBody) && issueNumber && repoFullName) {
    await handleSpikeApproval({
      issueNumber,
      repoFullName,
      recommendationCommentBody: commentBody,
    });
  }
}
```

**Important note for the executing agent**: The GitHub webhook reaction event structure may differ from what's shown above. Read the existing webhook handler carefully and adapt the payload field access to match. If the existing handler has a `body = await req.json()` with typed payload, use that. Do not add `any` casts everywhere — look at how the existing code types the payload and follow that pattern.

### Step 5: Update spike recommendation comment template

Open `lib/pm-prompts.ts` (or wherever spike recommendation comment text is generated — check `lib/spike-handoff.ts` and `lib/pm-agent.ts`). Find where the spike recommendation comment body is constructed and ensure it:

1. Includes `<!-- spike-recommendation -->` as a marker
2. Has `**Technical Question:**` and `**Scope:**` lines in the expected format

Example format to enforce:
```markdown
<!-- spike-recommendation -->
## 🔬 Spike Recommendation

**Technical Question:** What is the optimal database indexing strategy for the query pattern in the reports module?

**Scope:** 3-4 hours

**Recommended by:** PM Agent

To approve this spike, reply with "approve spike", "yes", "go ahead", or "+1".
To dismiss, reply with "dismiss" or "no".
```

If the template already has `**Technical Question:**` and `**Scope:**` but no marker, add the marker. If the template is missing entirely from the codebase, note this in the PR description but do not block the filing/detection logic.

### Step 6: TypeScript verification

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues to watch for:
- `createWorkItem` may not accept `type: 'spike'` if `type` is a union that doesn't include `'spike'` — add it to the union in `lib/types.ts` if needed
- `appendEvent` may have a strict event type union — either add `'spike_filed'` to it or use a compatible event type that already exists
- The webhook handler payload types may be loose (`any`) or strict — follow whatever pattern exists
- Import paths must match tsconfig `paths` config (check `tsconfig.json` for `@/` alias)

### Step 7: Verification

```bash
npx tsc --noEmit
npm run build
```

Check that:
- `lib/spike-filing.ts` exports `fileSpikeWorkItem` and `FileSpikeParams`
- The webhook file still has all original event handlers intact
- No `any` types were introduced where the existing code used specific types
- The approval keywords and marker string match the requirements exactly

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add spike filing module and webhook approval detection

- Add lib/spike-filing.ts with fileSpikeWorkItem() that creates spike work items
- Add spike approval detection to webhook handler for reply comments and reactions
- Detect spike recommendation comments via <!-- spike-recommendation --> marker
- Parse technicalQuestion and scope from structured comment format
- File spike work item with type 'spike' and spikeMetadata on approval"

git push origin feat/spike-filing-webhook-approval

gh pr create \
  --title "feat: spike filing module and webhook approval detection" \
  --body "## Summary

Implements the spike filing module and webhook-based approval detection.

### Changes

**\`lib/spike-filing.ts\`** (new)
- \`fileSpikeWorkItem(params)\` creates a work item with \`type: 'spike'\` and \`spikeMetadata\`
- Title derived from \`technicalQuestion\` (capped at 80 chars)
- Emits \`spike_filed\` event to the event bus

**\`app/api/webhooks/github/route.ts\`** (modified)
- Detects approval reply comments containing keywords: \`approve spike\`, \`yes\`, \`go ahead\`, \`+1\`
- Detects \`+1\`/heart reactions on spike recommendation comments
- Identifies spike recommendation comments via \`<!-- spike-recommendation -->\` marker
- Parses \`**Technical Question:**\` and \`**Scope:**\` from recommendation comment body
- Calls \`fileSpikeWorkItem()\` with \`recommendedBy: 'manual'\` on approval

### Acceptance Criteria
- [x] \`fileSpikeWorkItem()\` creates work item with \`type: 'spike'\` and correct \`spikeMetadata\`
- [x] Webhook detects approval reply keywords on spike recommendation comments
- [x] Webhook detects thumbs_up reaction on spike recommendation comments
- [x] Spike recommendation comments identified by \`<!-- spike-recommendation -->\` marker
- [x] TypeScript compiles without errors"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/spike-filing-webhook-approval
FILES CHANGED: [list files modified]
SUMMARY: [what was implemented]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "reaction event handling not added due to ambiguous payload type", "appendEvent type union needs 'spike_filed' added manually"]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve (e.g., `createWorkItem` signature is incompatible, `spikeMetadata` type doesn't exist and adding it causes cascading failures, webhook payload types are too strict to extend safely):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "spike-filing-webhook-approval",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message>",
      "filesChanged": ["lib/spike-filing.ts", "app/api/webhooks/github/route.ts"]
    }
  }'
```