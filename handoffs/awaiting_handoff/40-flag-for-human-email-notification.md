# Handoff 40: flag-for-human-email-notification

## Metadata
- Branch: `feat/flag-for-human-email-notification`
- Priority: high
- Model: opus
- Type: feature
- Max Budget: $5
- Risk Level: low
- Complexity: moderate
- Depends On: None
- Date: 2026-03-19
- Executor: Claude Code (GitHub Actions)

## Context

When TLM Code Review returns a FLAG_FOR_HUMAN decision, it only posts a GitHub PR comment. The human owner never sees it — they'd have to manually check GitHub PRs. This blocks pipeline throughput because flagged items sit in limbo until discovered by accident.

Agent Forge already has a full email system in `lib/gmail.ts` with `sendHtmlEmail()`, `sendEscalationEmail()`, rate limiting (3/project/hr, 10 global/hr), and Gmail OAuth2. The TLM Code Review action (`.github/actions/tlm-review/src/index.ts`) already produces structured `humanContext` data with: summary, risk assessment, options with tradeoffs, and a recommended path.

The fix: when FLAG_FOR_HUMAN fires in the TLM review action, POST to an Agent Forge API endpoint that sends a decision-oriented email via the existing Gmail infrastructure.

**Auth approach:** Reuse the existing `AGENT_FORGE_API_SECRET` (already in Vercel env and GitHub Actions secrets for both repos) rather than creating a new secret. This is the same pattern used by the escalation callback and work items API.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] `lib/gmail.ts` exists and exports `sendHtmlEmail`
- [ ] `.github/actions/tlm-review/src/index.ts` exists and contains a FLAG_FOR_HUMAN code path
- [ ] `.github/workflows/tlm-review.yml` exists
- [ ] `app/api/` directory exists (Next.js App Router structure is in place)

## Step 0: Branch, commit handoff, push

Create branch `feat/flag-for-human-email-notification` from `main`. Commit this handoff file. Push.

## Step 1: Create the notify endpoint

Create `app/api/notify/flag-for-human/route.ts` — a POST endpoint.

**Request shape:**