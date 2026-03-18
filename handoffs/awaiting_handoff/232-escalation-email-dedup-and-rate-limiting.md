# Handoff 232: escalation-email-dedup-and-rate-limiting

## Metadata
- Branch: `feat/escalation-email-dedup-and-rate-limiting`
- Priority: high
- Model: opus
- Type: bugfix
- Max Budget: $5
- Risk Level: low
- Complexity: moderate
- Depends On: None
- Date: 2026-03-18
- Executor: Claude Code (GitHub Actions)

## Context

On 2026-03-18, an infinite loop in ATC Section 4.5 caused 5 projects to cycle through plan validation failure every ~5 minutes for ~7 hours, generating ~200 duplicate escalation emails. The loop itself was fixed in PR #234 (transitions to Failed on validation failure + loop detection after 3 failures). However, the email system has no dedup or rate limiting — a single project failure can generate unlimited emails if the ATC cycle reprocesses it. This handoff adds three defensive layers: (1) email dedup via Blob store keys, (2) project-level escalation records (parity with work-item escalations), and (3) global rate limiting on all escalation email paths.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] Verify `sendProjectEscalationEmail()` exists in `lib/gmail.ts` and understand its current call sites
- [ ] Verify the Escalation type in `lib/escalation.ts` and how work-item escalations are created
- [ ] Verify Blob store is available and understand the existing key naming conventions
- [ ] Check the MCP `list_escalations` route to understand the current response format

## Step 0: Branch, commit handoff, push

Create branch `feat/escalation-email-dedup-and-rate-limiting` from `main`. Commit this handoff file. Push.

## Step 1: Add email dedup to `sendProjectEscalationEmail()` in `lib/gmail.ts`: Before sending, check Blob store for key `project-escalation:{projectId}:{escalationType}`. If key exists and is <24h old, log 'Skipping duplicate escalation email' and return early. After sending, set the key with 24h TTL.

## Step 2: Add project-level escalation records: In `lib/escalation.ts`, extend the existing `Escalation` type (or create `ProjectEscalation`) with a `projectId` field. In `lib/atc.ts` Section 4.5, before sending an email, check for an existing pending escalation for the same project+reason. If found, skip. If not, create the record, then send the email.

## Step 3: Add global rate limiter to `lib/gmail.ts`: Create a `checkEscalationRateLimit(projectId: string)` function that enforces max 3 escalation emails per project per hour and max 10 total escalation emails per hour. Use Blob store counters with hourly TTL. Call this before every `sendProjectEscalationEmail()` and `sendEscalationEmail()` invocation.

## Step 4: Expose project escalations in the MCP `list_escalations` tool: Update `app/api/mcp/tools/list-escalations/route.ts` to include project-level escalations in results. Ensure they follow the same pending/resolved/expired lifecycle as work-item escalations.

## Step 5: Add tests: Unit test the dedup logic (second call within 24h returns early), rate limiter (4th call within an hour for same project is blocked), and project escalation record creation. Integration test: trigger two plan validation failures for the same project and verify only 1 email is sent.

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: escalation-email-dedup-and-rate-limiting (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "feat/escalation-email-dedup-and-rate-limiting",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```