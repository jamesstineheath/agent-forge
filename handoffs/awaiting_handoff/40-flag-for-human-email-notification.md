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

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] app/api/notify/flag-for-human/route.ts exists and exports POST handler
- [ ] Handler validates Authorization header against NOTIFY_SECRET
- [ ] Handler calls sendHtmlEmail from lib/gmail.ts
- [ ] TLM review action POSTs to the notify endpoint on FLAG_FOR_HUMAN
- [ ] HTTP call is wrapped in try/catch so failures don't block the review
- [ ] tlm-review.yml has NOTIFY_SECRET and AGENT_FORGE_URL in env

## Step 0: Branch, commit handoff, push

Create branch `feat/flag-for-human-email-notification` from `main`. Commit this handoff file. Push.

## Step 1: Create `app/api/notify/flag-for-human/route.ts` — a POST endpoint that accepts `{ repo, prNumber, prTitle, prUrl, summary, riskAssessment, options, recommendedPath }`. It should: (a) validate the payload, (b) call `sendHtmlEmail()` from `lib/gmail.ts` with a well-formatted HTML email. Subject: `[Pipeline Decision] PR #${prNumber} — ${prTitle}`. Body should include: what's at stake (summary), risk level, numbered options with tradeoffs, recommended path, and a direct link to the PR. (c) Return 200 on success. Protect the endpoint with a shared secret via `NOTIFY_SECRET` env var checked against an `Authorization: Bearer <secret>` header.

## Step 2: In `.github/actions/tlm-review/src/index.ts`, after the FLAG_FOR_HUMAN decision block (where `core.setOutput('decision', 'flag_for_human')` is set and the humanContext is built), add an HTTP POST to `${process.env.AGENT_FORGE_URL || 'https://agent-forge.vercel.app'}/api/notify/flag-for-human` with the humanContext payload. Include `Authorization: Bearer ${process.env.NOTIFY_SECRET}` header. Wrap in try/catch — email failure should not block the review action. Log success/failure.

## Step 3: Add `NOTIFY_SECRET` to the GitHub Actions workflow environment. In `.github/workflows/tlm-review.yml`, add `NOTIFY_SECRET: ${{ secrets.NOTIFY_SECRET }}` and `AGENT_FORGE_URL: ${{ secrets.AGENT_FORGE_URL }}` to the review step's env block. Do the same in the personal-assistant repo's `.github/workflows/tlm-review.yml` if it exists (it references the agent-forge action at @main).

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: flag-for-human-email-notification (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "feat/flag-for-human-email-notification",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```

## Post-merge Note

After merge, set NOTIFY_SECRET in both Vercel (agent-forge project) and GitHub Actions secrets (both agent-forge and personal-assistant repos). Use a strong random string: `openssl rand -hex 32`.