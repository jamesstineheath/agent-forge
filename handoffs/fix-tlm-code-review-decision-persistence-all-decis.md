<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- Fix TLM Code Review Decision Persistence

## Metadata
- **Branch:** `fix/tlm-decision-persistence`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** .github/actions/tlm-review/src/index.ts, .github/actions/tlm-outcome-tracker/src/index.ts

## Context

The Feedback Compiler (PR #392) identified a critical bug: ALL 45 recent PRs show `TLM Decision: unknown` in the Outcome Tracker's assessments. This breaks the TLM self-improvement feedback loop because the Outcome Tracker cannot assess whether Code Reviewer decisions were correct without knowing what decisions were made.

The system has two relevant components:
1. **TLM Code Review** (`.github/actions/tlm-review/`): Reviews PRs, makes decisions (APPROVE / REQUEST_CHANGES / FLAG_FOR_HUMAN), and should persist that decision somewhere readable.
2. **TLM Outcome Tracker** (`.github/actions/tlm-outcome-tracker/`): Daily cron that reads past decisions and assesses whether they were correct.

The Feedback Compiler classified this as "critical" severity and "cross_agent_misalignment" — the two agents are out of sync on how the decision is stored/retrieved. 24 historical assessments exist, suggesting this worked at some point and regressed.

The fix is straightforward: locate where the mismatch is (storage key, comment format, or missing persistence call) and align the two sides.

## Requirements

1. The TLM Code Review action must persist its final decision string (one of: `APPROVE`, `REQUEST_CHANGES`, `FLAG_FOR_HUMAN`) in a location/format the Outcome Tracker can reliably retrieve.
2. The Outcome Tracker must correctly retrieve the decision for each PR it assesses — the retrieved value must not default to `unknown` when a review was actually performed.
3. The fix must not break existing TLM review behavior (posting GitHub PR reviews, auto-merge logic, etc.).
4. The storage key or comment marker used by both sides must be consistent — document the agreed-upon key/marker in a code comment.
5. After the fix, any PR reviewed by TLM Code Review going forward will have a non-`unknown` decision in the next Outcome Tracker cycle.
6. No new dependencies introduced; use only existing storage mechanisms already in the codebase.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/tlm-decision-persistence
```

### Step 1: Audit TLM Code Review decision persistence

Inspect the review action source to understand how it currently handles the decision:

```bash
# Look at the full review action source
cat .github/actions/tlm-review/src/index.ts
ls .github/actions/tlm-review/src/
cat .github/actions/tlm-review/src/*.ts 2>/dev/null || true
```

Look for:
- Where `APPROVE`, `REQUEST_CHANGES`, or `FLAG_FOR_HUMAN` is determined
- Whether that decision string is written anywhere after the review (GitHub PR review comment, output variable, Blob storage, a summary comment, a step output)
- Any calls to `core.setOutput`, Blob storage writes, or GitHub API comment creation that include the decision

Take note of the exact format used (e.g., does it write `Decision: APPROVE` in a comment body? Does it use a specific structured marker?).

### Step 2: Audit TLM Outcome Tracker decision retrieval

Inspect the outcome tracker to understand how it tries to read the decision:

```bash
cat .github/actions/tlm-outcome-tracker/src/index.ts
ls .github/actions/tlm-outcome-tracker/src/
cat .github/actions/tlm-outcome-tracker/src/*.ts 2>/dev/null || true
```

Look for:
- How it locates TLM-reviewed PRs
- The exact key/pattern it uses to extract the decision (e.g., regex on comment body, Blob key lookup, GitHub review state check)
- What it returns/defaults to when the decision cannot be found (confirm it defaults to `unknown`)

### Step 3: Identify the mismatch

Compare findings from Steps 1 and 2. The mismatch will be one of:

**Case A — Decision not persisted at all:**
The review action makes a decision internally but never writes it to a retrievable location (no comment marker, no Blob write, no output). The Outcome Tracker tries to find it and gets nothing → `unknown`.

**Case B — Storage key mismatch:**
The review action writes `tlm-decision: APPROVE` but the Outcome Tracker looks for `TLM Decision: APPROVE` (or vice versa) — a regex/key mismatch.

**Case C — Comment structure changed:**
The review action previously wrote the decision in a structured comment that the Outcome Tracker parsed. A recent change to the comment format broke the parser.

**Case D — GitHub API query issue:**
The Outcome Tracker queries the wrong comment type (e.g., looks at PR review comments instead of issue comments, or vice versa).

Document which case applies before proceeding.

### Step 4: Implement the fix

#### If Case A (decision not persisted):

In `.github/actions/tlm-review/src/index.ts` (or whichever file finalizes the review), after the decision is made, add a structured marker to the PR review body or a separate issue comment. Use a clearly identifiable format:

```typescript
// After decision is determined, ensure it is embedded in the review comment body
// with a machine-readable marker the Outcome Tracker can parse.
// Agreed format: <!-- tlm-decision: APPROVE --> (HTML comment, invisible to humans)
const decisionMarker = `<!-- tlm-decision: ${decision} -->`;

// Append to the review body before submitting
const reviewBody = `${existingReviewBody}\n\n${decisionMarker}`;
```

Alternatively, if the action already creates a PR comment, ensure the decision marker is included there.

#### If Case B or C (key/format mismatch):

Pick one canonical format. Prefer whatever is already closest to working. Update the **reader** side (Outcome Tracker) to match the writer side (Review action), since changing the writer risks affecting human-visible content.

In `.github/actions/tlm-outcome-tracker/src/index.ts`, update the regex/key to match exactly what the review action writes:

```typescript
// Example: if review action writes <!-- tlm-decision: APPROVE -->
const decisionMatch = commentBody.match(/<!--\s*tlm-decision:\s*(APPROVE|REQUEST_CHANGES|FLAG_FOR_HUMAN)\s*-->/);
const decision = decisionMatch ? decisionMatch[1] : 'unknown';
```

#### If Case D (wrong comment type):

Update the GitHub API call in the Outcome Tracker to query the correct comment type. Example: if it's querying `GET /repos/{owner}/{repo}/issues/{issue_number}/comments` but the review action uses `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`, switch to:

```typescript
// Use GitHub Reviews API, not issue comments
const reviews = await octokit.pulls.listReviews({ owner, repo, pull_number: prNumber });
const tlmReview = reviews.data.find(r => r.body?.includes('<!-- tlm-decision:'));
```

### Step 5: Verify the fix logic with a dry-run trace

After making changes, trace through the logic manually:

1. Confirm the review action will write the decision in the agreed format
2. Confirm the Outcome Tracker's parser will correctly extract it
3. Check edge cases: what if the review action fails partway through — is the decision marker still written? What if multiple TLM reviews exist on the same PR?

Add a code comment near the decision persistence and retrieval points in both files:

```typescript
// TLM DECISION CONTRACT:
// Writer (.github/actions/tlm-review): embeds decision as <!-- tlm-decision: {DECISION} -->
// in the PR review body (submitted via createReview API).
// Reader (.github/actions/tlm-outcome-tracker): extracts via regex on review body.
// Valid values: APPROVE | REQUEST_CHANGES | FLAG_FOR_HUMAN
// Default when not found: 'unknown'
```

### Step 6: Check for TypeScript compilation

```bash
# Check the review action
cd .github/actions/tlm-review
npm install 2>/dev/null || true
npx tsc --noEmit 2>/dev/null || echo "No tsconfig found, skipping"
cd ../../..

# Check the outcome tracker
cd .github/actions/tlm-outcome-tracker
npm install 2>/dev/null || true
npx tsc --noEmit 2>/dev/null || echo "No tsconfig found, skipping"
cd ../../..
```

Also check the root project compiles:

```bash
npx tsc --noEmit
npm run build 2>/dev/null || true
```

Fix any TypeScript errors before proceeding.

### Step 7: Review tlm-memory.md for context

```bash
cat docs/tlm-memory.md
```

Check if there are any additional clues about when the decision recording stopped working (look for the last assessment with a non-unknown decision). This can help confirm the fix targets the right regression point. No changes needed to this file — it will be updated naturally by the next Outcome Tracker run.

### Step 8: Verification

```bash
# Confirm no TypeScript errors in root
npx tsc --noEmit

# Confirm build passes
npm run build

# Confirm tests pass if any exist
npm test 2>/dev/null || echo "No test suite"

# Grep to confirm the decision marker pattern is consistent between both files
echo "=== Writer (tlm-review) decision output ==="
grep -n "tlm-decision\|APPROVE\|REQUEST_CHANGES\|FLAG_FOR_HUMAN\|decision" .github/actions/tlm-review/src/*.ts | head -30

echo "=== Reader (tlm-outcome-tracker) decision lookup ==="
grep -n "tlm-decision\|APPROVE\|REQUEST_CHANGES\|FLAG_FOR_HUMAN\|decision\|unknown" .github/actions/tlm-outcome-tracker/src/*.ts | head -30
```

Confirm visually that the pattern written by the review action is matched by the regex/lookup in the outcome tracker.

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "fix: align TLM Code Review decision persistence with Outcome Tracker retrieval

All 45 recent PRs showed TLM Decision: unknown, breaking the self-improvement
feedback loop. Root cause: [FILL IN: Case A/B/C/D - brief description].

Fix:
- [tlm-review] [what was changed]
- [tlm-outcome-tracker] [what was changed]

Decision contract: <!-- tlm-decision: {DECISION} --> embedded in PR review body.
Valid values: APPROVE | REQUEST_CHANGES | FLAG_FOR_HUMAN

Closes #[issue number if any]. Addresses Feedback Compiler pattern-003."

git push origin fix/tlm-decision-persistence

gh pr create \
  --title "fix: TLM Code Review decision persistence (all decisions showing unknown)" \
  --body "## Problem

All 45 recent PRs showed \`TLM Decision: unknown\` in Outcome Tracker assessments, breaking the TLM self-improvement feedback loop. Identified as critical by Feedback Compiler (PR #392, pattern-003).

## Root Cause

[FILL IN after investigation: which case applied and exact mismatch]

## Fix

- **\`.github/actions/tlm-review/src/\`**: [describe change]
- **\`.github/actions/tlm-outcome-tracker/src/\`**: [describe change]

## Decision Contract

Both sides now agree on the format:
- **Writer**: embeds \`<!-- tlm-decision: {DECISION} -->\` in PR review body
- **Reader**: extracts via regex on review bodies
- **Valid values**: \`APPROVE\` | \`REQUEST_CHANGES\` | \`FLAG_FOR_HUMAN\`

## Verification

After the next Outcome Tracker cycle, \`docs/tlm-memory.md\` should show non-unknown decisions for recently reviewed PRs.

## Risk

Low — only affects how the decision string is persisted/retrieved. No changes to review logic, auto-merge behavior, or human-visible review content (decision marker is an HTML comment)."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: fix/tlm-decision-persistence
FILES CHANGED: [list of files modified]
SUMMARY: [what was investigated and changed]
ISSUES: [what failed or remains unclear]
NEXT STEPS: [e.g., "Case D confirmed — need to update GitHub API query in outcome-tracker/src/index.ts line ~142 to use pulls.listReviews instead of issues.listComments"]
```

## Escalation Protocol

If the executing agent encounters a blocker it cannot resolve autonomously (e.g., the decision is persisted to an external store that requires credentials not available in the repo, or the architecture is fundamentally different from what's described above), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "fix-tlm-decision-persistence",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": [".github/actions/tlm-review/src/index.ts", ".github/actions/tlm-outcome-tracker/src/index.ts"]
    }
  }'
```