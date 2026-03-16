# Agent Forge -- Add project escalation email function to gmail.ts

## Metadata
- **Branch:** `feat/project-escalation-email`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/gmail.ts

## Context

Agent Forge uses Gmail OAuth2 to send notification emails for escalations and decomposition summaries. The existing `lib/gmail.ts` already has a `sendEscalationEmail` function that accepts a `WorkItem` and composes a work-item-scoped escalation email. There is also an escalation state machine in `lib/escalation.ts`.

The system needs a parallel function for **project-level** escalations — situations where an entire project (not just a single work item) needs human attention. The new function should follow the same patterns as existing Gmail functions: reuse the OAuth2 client setup, handle missing credentials gracefully (return false, never throw), and compose a clear email.

The existing `sendEscalationEmail` function signature for reference:
```typescript
export async function sendEscalationEmail(params: {
  workItemId: string;
  title: string;
  reason: string;
  repoFullName: string;
  prUrl?: string;
}): Promise<boolean>
```

The new function should mirror this style but accept project-level metadata instead of work item fields.

## Requirements

1. Add a new exported function `sendProjectEscalationEmail` to `lib/gmail.ts`
2. Function signature must be exactly:
   ```typescript
   export async function sendProjectEscalationEmail(params: {
     projectId: string;
     projectTitle: string;
     reason: string;
     context?: string;
     escalationType: string;
   }): Promise<boolean>
   ```
3. Email subject must be: `[Agent Forge] Project Escalation: {projectTitle}`
4. Email body must include: project ID, escalation type, reason, and optional context
5. Function must return `false` (not throw) when Gmail credentials are missing
6. Function must return `false` (not throw) when sending fails (catch all errors)
7. Function must return `true` on successful send
8. Reuse the existing Gmail OAuth2 client construction pattern already in the file
9. The file must compile without TypeScript errors (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/project-escalation-email
```

### Step 1: Inspect existing gmail.ts

Read `lib/gmail.ts` in full to understand:
- How the OAuth2 client is constructed (likely using `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`)
- How `sendEscalationEmail` composes and sends the email (the Gmail API call pattern)
- What imports are already present
- The exact error handling pattern (try/catch returning false)
- The recipient address used in existing emails

This is critical — the new function must reuse the same OAuth2 client setup and Gmail API call pattern exactly.

### Step 2: Add `sendProjectEscalationEmail` to lib/gmail.ts

After the existing `sendEscalationEmail` function (or at the end of the file), add the new function. It should:

1. Check for required Gmail env vars (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`) — return `false` if any are missing, matching the existing guard pattern
2. Construct the OAuth2 client the same way the existing function does
3. Compose the email:
   - **Subject:** `[Agent Forge] Project Escalation: {projectTitle}`
   - **Body (plain text + HTML):** Include project ID, escalation type, reason, and context (if provided)
4. Send via Gmail API using the same method as existing functions
5. Return `true` on success
6. Catch all errors, log them, return `false`

Example body structure to implement:
```
Agent Forge – Project Escalation

Project: {projectTitle}
Project ID: {projectId}
Escalation Type: {escalationType}

Reason:
{reason}

{context ? `Additional Context:\n${context}` : ''}

---
This is an automated notification from Agent Forge.
```

### Step 3: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding.

### Step 4: Smoke-check the function exists and is exported

```bash
grep -n "sendProjectEscalationEmail" lib/gmail.ts
```

Expected output: at least one line showing the `export async function sendProjectEscalationEmail` declaration.

### Step 5: Commit, push, open PR

```bash
git add lib/gmail.ts
git commit -m "feat: add sendProjectEscalationEmail function to gmail.ts"
git push origin feat/project-escalation-email
gh pr create \
  --title "feat: add sendProjectEscalationEmail to gmail.ts" \
  --body "## Summary

Adds a new \`sendProjectEscalationEmail\` exported function to \`lib/gmail.ts\` for project-level escalation notifications.

## Changes
- \`lib/gmail.ts\`: Added \`sendProjectEscalationEmail(params: { projectId, projectTitle, reason, context?, escalationType }): Promise<boolean>\`

## Behavior
- Email subject: \`[Agent Forge] Project Escalation: {projectTitle}\`
- Reuses existing OAuth2 client setup and error handling patterns
- Returns \`false\` (never throws) when credentials are missing or send fails
- Returns \`true\` on successful send

## Acceptance Criteria
- [x] Function exported from lib/gmail.ts with correct signature
- [x] Subject line includes project title
- [x] Graceful degradation on missing credentials or send failure
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
BRANCH: feat/project-escalation-email
FILES CHANGED: [lib/gmail.ts]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If the executing agent encounters a blocker it cannot resolve autonomously (e.g., the Gmail API integration is more complex than expected, or the existing patterns are ambiguous), escalate via:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-project-escalation-email",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/gmail.ts"]
    }
  }'
```