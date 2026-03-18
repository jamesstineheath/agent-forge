# Handoff 39: event-bus-webhook-handler

## Metadata
- Branch: `feat/event-bus-webhook-handler`
- Priority: high
- Model: opus
- Type: feature
- Max Budget: $6
- Risk Level: low
- Complexity: moderate
- Depends On: None
- Date: 2026-03-18
- Executor: Claude Code (GitHub Actions)

## Context

Agent Forge is currently 100% polling-based — one Vercel cron every 5 minutes, no webhooks, no event bus. This is the foundation for migrating to an event-driven autonomous agent architecture.

This handoff adds a GitHub webhook handler and durable event log WITHOUT changing any existing behavior. It starts collecting events alongside the existing polling so we can validate event reliability before switching agents to consume them.

Current infrastructure:
- Single cron at `/api/atc/cron` (every 5 min)
- Events stored in Vercel Blob at `atc/events` (rolling 1000, ephemeral)
- No webhook routes exist
- GitHub API polling makes ~20-30 calls per cycle
- Event types defined in `lib/types.ts` (ATCEvent interface)

After this handoff:
- New route `/api/webhooks/github` receives GitHub webhook events
- Events stored in a durable log (Vercel Blob, partitioned by hour)
- Existing ATC cron continues unchanged
- Dashboard can show webhook event feed for monitoring

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] Confirm no `/api/webhooks/` routes exist yet
- [ ] Confirm `lib/event-bus.ts` does not exist yet
- [ ] Confirm `@vercel/blob` is in package.json dependencies (used by existing storage)
- [ ] Confirm the existing ATC cron route is NOT modified by this handoff

## Step 0: Branch, commit handoff, push

Create branch `feat/event-bus-webhook-handler` from `main`. Commit this handoff file. Push.

## Step 1: Read existing infrastructure

Read these files to understand patterns:
- `lib/types.ts` (ATCEvent interface, event types)
- `lib/storage.ts` (Vercel Blob read/write patterns)
- `app/api/atc/cron/route.ts` (cron route structure)
- `app/api/atc/events/route.ts` (event serving pattern)
- `vercel.json` (current configuration)
- `lib/github.ts` (GitHub API patterns)

## Step 2: Create event bus types

Create `lib/event-bus-types.ts` with WebhookEvent interface and GitHubEventType union:
- `github.pr.opened`, `github.pr.merged`, `github.pr.closed`
- `github.ci.passed`, `github.ci.failed`
- `github.workflow.completed`, `github.push`

## Step 3: Create event bus storage module

Create `lib/event-bus.ts`:
- `appendEvents(events: WebhookEvent[])` — appends to hourly-partitioned blob (`events/YYYY-MM-DD-HH.json`)
- `queryEvents(opts: { since?, types?, repo?, limit? })` — queries across partitions
- `getRecentEvents(minutes: number)` — convenience wrapper
- Cleanup function for partitions older than 7 days
- Use Vercel Blob (`@vercel/blob`), same patterns as existing `lib/storage.ts`

## Step 4: Create GitHub webhook handler

Create `app/api/webhooks/github/route.ts`:
- Verify webhook signature using `GITHUB_WEBHOOK_SECRET` (crypto.timingSafeEqual with HMAC-SHA256)
- Parse `X-GitHub-Event` header, map to WebhookEvent types
- Extract relevant payload fields (PR number, branch, repo, commit SHA, workflow name)
- Call `appendEvents()` to store
- Return 200 OK immediately (must be fast)
- Log errors but never return 500 (GitHub retries cause duplicates)

## Step 5: Create event query API

Create `app/api/events/route.ts`:
- `GET /api/events?since=ISO&types=github.pr.merged,github.ci.failed&repo=owner/repo&limit=50`
- Auth: `AGENT_FORGE_API_SECRET` bearer token
- Returns JSON array of WebhookEvent

## Step 6: Add event feed to dashboard

Read existing dashboard structure. Add a small 'Recent Webhook Events' table showing last 20 events with timestamp, type, repo, payload summary. Lightweight addition to existing page, not a new page.

## Step 7: Update documentation

Add `GITHUB_WEBHOOK_SECRET` to env var docs. Add webhook handler and event bus to `docs/SYSTEM_MAP.md`.

## Step 8: Build and verify

- `npx tsc --noEmit` passes
- Webhook handler compiles and route is accessible
- Event bus storage write/read works
- Existing ATC cron is unmodified

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: event-bus-webhook-handler (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "feat/event-bus-webhook-handler",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```