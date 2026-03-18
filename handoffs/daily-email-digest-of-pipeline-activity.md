<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Daily Email Digest of Pipeline Activity

## Metadata
- **Branch:** `feat/daily-pipeline-digest`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** `app/api/agents/digest/cron/route.ts`, `lib/digest.ts`, `vercel.json`

## Context

Agent Forge already has Gmail API integration (`lib/gmail.ts`) used for escalation emails and decomposition summaries. The event bus (`lib/event-bus.ts`) stores hourly Vercel Blob partitions with a 30-day retention window. Work items live in Vercel Blob at `af-data/work-items/*`. Escalations are stored at `escalations/*`. The four autonomous agents (Dispatcher, Health Monitor, Project Manager, Supervisor) emit events to the event log (`lib/atc/events.ts`).

There are existing cron routes at `app/api/agents/dispatcher/cron/route.ts`, `app/api/agents/health-monitor/cron/route.ts`, etc. The pattern is: each cron route is authenticated via `CRON_SECRET` header, does its work, and returns a JSON response. Vercel cron jobs are registered in `vercel.json`.

The concurrent work item on branch `fix/bootstrap-rez-sniper-push-execute-handoffyml-via-g` touches `handoffs/` and ephemeral scripts — **no overlap** with this task.

## Requirements

1. Create `lib/digest.ts` with a `buildDailyDigest()` function that assembles all digest data from the past 24 hours.
2. Digest data must include:
   - PRs merged in last 24h (title, URL, repo, outcome from TLM memory if available)
   - PRs currently open (title, URL, CI status, review status)
   - Work items dispatched, completed, failed, and stuck in last 24h
   - Agent health: last-run timestamps for Dispatcher, Health Monitor, Project Manager, Supervisor (derived from event log)
   - Escalations raised or resolved in last 24h
   - Feedback Compiler proposals from last 24h
   - Event bus stats: total events and breakdown by type
3. Create `app/api/agents/digest/cron/route.ts` that:
   - Authenticates via `CRON_SECRET` header (same pattern as other cron routes)
   - Calls `buildDailyDigest()` to collect data
   - Renders a clean HTML email
   - Sends via the existing Gmail API (`lib/gmail.ts`)
   - Returns JSON with summary of what was sent
4. Register the cron in `vercel.json` to run daily at 8:00 AM UTC.
5. The email must open with a one-line health summary: "✅ All systems healthy" or "⚠️ N issues need attention" where issues = failed work items + open escalations + agents not seen in 24h.
6. All links in the email must be absolute URLs (use `AGENT_FORGE_URL` env var for internal links, GitHub URLs for PRs).
7. TypeScript must compile without errors (`npx tsc --noEmit`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/daily-pipeline-digest
```

### Step 1: Understand existing patterns

Read the following files to understand existing conventions before writing any code:

```bash
cat lib/gmail.ts
cat lib/event-bus.ts
cat lib/atc/events.ts
cat lib/work-items.ts
cat lib/escalation.ts
cat lib/github.ts
cat app/api/agents/dispatcher/cron/route.ts
cat app/api/agents/health-monitor/cron/route.ts
cat vercel.json
cat lib/types.ts
```

Key things to note:
- How `sendEmail()` or equivalent is called in `lib/gmail.ts`
- How event bus queries work (time range, event types)
- The `WorkItem` type shape (status field values: `filed`, `ready`, `queued`, `generating`, `executing`, `reviewing`, `merged`, `blocked`, `parked`, `failed`)
- How cron routes check `CRON_SECRET`
- Existing vercel.json cron structure

### Step 2: Create `lib/digest.ts`

Create `lib/digest.ts`. Use the patterns observed in Step 1. Here is the full implementation to adapt:

```typescript
import { listWorkItems } from './work-items';
import { listEscalations } from './escalation';
import { queryEvents } from './event-bus';
import { getOctokit } from './github'; // or however GitHub client is instantiated
import type { WorkItem } from './types';

const AGENT_FORGE_URL = process.env.AGENT_FORGE_URL ?? 'https://agent-forge.vercel.app';
const GH_ORG = 'jamesstineheath';
const GH_REPO = 'agent-forge';

export interface AgentHealth {
  name: string;
  lastSeen: Date | null;
  healthy: boolean;
}

export interface DigestData {
  generatedAt: Date;
  windowStart: Date;
  windowEnd: Date;
  mergedPRs: MergedPR[];
  openPRs: OpenPR[];
  workItemStats: WorkItemStats;
  agentHealth: AgentHealth[];
  escalations: EscalationSummary[];
  feedbackProposals: FeedbackProposal[];
  eventStats: EventStats;
  issueCount: number;
  healthSummary: string;
}

export interface MergedPR {
  number: number;
  title: string;
  url: string;
  repo: string;
  mergedAt: string;
  hadIssues: boolean;
}

export interface OpenPR {
  number: number;
  title: string;
  url: string;
  repo: string;
  ciStatus: 'passing' | 'failing' | 'pending' | 'unknown';
  reviewStatus: string;
  createdAt: string;
}

export interface WorkItemStats {
  dispatched: WorkItem[];
  completed: WorkItem[];
  failed: WorkItem[];
  stuck: WorkItem[];
}

export interface EscalationSummary {
  id: string;
  reason: string;
  status: string;
  workItemId: string;
  createdAt: string;
}

export interface FeedbackProposal {
  description: string;
  createdAt: string;
}

export interface EventStats {
  total: number;
  byType: Record<string, number>;
}

export async function buildDailyDigest(): Promise<DigestData> {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);

  // 1. Query event bus for last 24h
  const events = await queryEvents({ since: windowStart, until: windowEnd });

  // 2. Work item stats
  const allWorkItems = await listWorkItems();
  const recentlyUpdated = allWorkItems.filter((wi: WorkItem) => {
    const updatedAt = new Date(wi.updatedAt ?? wi.createdAt);
    return updatedAt >= windowStart;
  });

  const dispatched = recentlyUpdated.filter((wi: WorkItem) =>
    ['queued', 'generating', 'executing'].includes(wi.status)
  );
  const completed = recentlyUpdated.filter((wi: WorkItem) => wi.status === 'merged');
  const failed = recentlyUpdated.filter((wi: WorkItem) =>
    ['failed', 'parked'].includes(wi.status)
  );
  // Stuck = executing/reviewing for > 2 hours
  const twoHoursAgo = new Date(windowEnd.getTime() - 2 * 60 * 60 * 1000);
  const stuck = allWorkItems.filter((wi: WorkItem) => {
    if (!['executing', 'reviewing', 'generating'].includes(wi.status)) return false;
    const updatedAt = new Date(wi.updatedAt ?? wi.createdAt);
    return updatedAt < twoHoursAgo;
  });

  // 3. Agent health — derive from event log
  const agentNames = ['Dispatcher', 'HealthMonitor', 'ProjectManager', 'Supervisor'];
  const agentHealth: AgentHealth[] = agentNames.map((name) => {
    // Events emitted by each agent have a source or type field containing the agent name
    // Adapt this filter based on actual event schema observed in Step 1
    const agentEvents = events.filter((e: any) => {
      const src = (e.source ?? e.type ?? e.agentId ?? '').toLowerCase();
      return src.includes(name.toLowerCase().replace('monitor', '-monitor').replace('manager', '-manager'));
    });
    const lastSeen = agentEvents.length > 0
      ? new Date(Math.max(...agentEvents.map((e: any) => new Date(e.timestamp).getTime())))
      : null;
    return {
      name,
      lastSeen,
      healthy: lastSeen !== null && lastSeen >= windowStart,
    };
  });

  // 4. Escalations
  const allEscalations = await listEscalations();
  const recentEscalations: EscalationSummary[] = allEscalations
    .filter((e: any) => new Date(e.createdAt) >= windowStart)
    .map((e: any) => ({
      id: e.id,
      reason: e.reason ?? 'Unknown',
      status: e.status ?? 'pending',
      workItemId: e.workItemId ?? '',
      createdAt: e.createdAt,
    }));

  // 5. GitHub PRs — merged in last 24h and currently open
  // Use the existing GitHub client
  const octokit = getOctokit(); // adapt to actual export
  const { data: mergedPRsRaw } = await octokit.rest.pulls.list({
    owner: GH_ORG,
    repo: GH_REPO,
    state: 'closed',
    sort: 'updated',
    direction: 'desc',
    per_page: 50,
  });

  const mergedPRs: MergedPR[] = mergedPRsRaw
    .filter((pr: any) => pr.merged_at && new Date(pr.merged_at) >= windowStart)
    .map((pr: any) => ({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      repo: GH_REPO,
      mergedAt: pr.merged_at,
      hadIssues: false, // Could cross-reference TLM memory if available
    }));

  const { data: openPRsRaw } = await octokit.rest.pulls.list({
    owner: GH_ORG,
    repo: GH_REPO,
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: 50,
  });

  const openPRs: OpenPR[] = await Promise.all(
    openPRsRaw.map(async (pr: any) => {
      let ciStatus: OpenPR['ciStatus'] = 'unknown';
      try {
        const { data: checks } = await octokit.rest.checks.listForRef({
          owner: GH_ORG,
          repo: GH_REPO,
          ref: pr.head.sha,
        });
        const runs = checks.check_runs ?? [];
        if (runs.length === 0) ciStatus = 'unknown';
        else if (runs.every((r: any) => r.conclusion === 'success')) ciStatus = 'passing';
        else if (runs.some((r: any) => r.conclusion === 'failure')) ciStatus = 'failing';
        else ciStatus = 'pending';
      } catch {
        ciStatus = 'unknown';
      }
      return {
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        repo: GH_REPO,
        ciStatus,
        reviewStatus: pr.draft ? 'draft' : 'open',
        createdAt: pr.created_at,
      };
    })
  );

  // 6. Feedback Compiler proposals — look for events of the right type
  const feedbackEvents = events.filter((e: any) =>
    (e.type ?? '').toLowerCase().includes('feedback') ||
    (e.type ?? '').toLowerCase().includes('proposal')
  );
  const feedbackProposals: FeedbackProposal[] = feedbackEvents.map((e: any) => ({
    description: e.message ?? e.description ?? e.type ?? 'Feedback proposal',
    createdAt: e.timestamp,
  }));

  // 7. Event stats
  const eventStats: EventStats = {
    total: events.length,
    byType: events.reduce((acc: Record<string, number>, e: any) => {
      const t = e.type ?? 'unknown';
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    }, {}),
  };

  // 8. Health summary
  const unhealthyAgents = agentHealth.filter((a) => !a.healthy);
  const issueCount =
    failed.length +
    stuck.length +
    recentEscalations.filter((e) => e.status === 'pending').length +
    unhealthyAgents.length;

  const healthSummary =
    issueCount === 0
      ? '✅ All systems healthy'
      : `⚠️ ${issueCount} issue${issueCount === 1 ? '' : 's'} need${issueCount === 1 ? 's' : ''} attention`;

  return {
    generatedAt: windowEnd,
    windowStart,
    windowEnd,
    mergedPRs,
    openPRs,
    workItemStats: { dispatched, completed, failed, stuck },
    agentHealth,
    escalations: recentEscalations,
    feedbackProposals,
    eventStats,
    issueCount,
    healthSummary,
  };
}
```

**Important:** After reading the actual files in Step 1, adapt the following:
- The `queryEvents` call signature — check what `lib/event-bus.ts` actually exports and how time-range queries work.
- The `listEscalations` export — check `lib/escalation.ts` for the correct function name.
- The GitHub client instantiation — check `lib/github.ts` for the correct export (`getOctokit`, `octokit`, `createOctokit`, etc.).
- The `listWorkItems` call — verify the function signature in `lib/work-items.ts`.
- Event schema for agent health — look at `lib/atc/events.ts` for the shape of emitted events to find the right field to filter on.

### Step 3: Create the HTML email renderer

Add a `renderDigestHtml(data: DigestData): string` function to `lib/digest.ts`. Here is the template to implement:

```typescript
export function renderDigestHtml(data: DigestData): string {
  const fmt = (d: Date | string) =>
    new Date(d).toLocaleString('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }) + ' UTC';

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      passing: '#16a34a',
      failing: '#dc2626',
      pending: '#ca8a04',
      unknown: '#6b7280',
    };
    const color = colors[status] ?? '#6b7280';
    return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;">${status}</span>`;
  };

  const prRow = (pr: MergedPR | OpenPR) => {
    const isMerged = 'mergedAt' in pr;
    const detail = isMerged
      ? `Merged ${fmt(pr.mergedAt)}`
      : `CI: ${statusBadge((pr as OpenPR).ciStatus)} · ${(pr as OpenPR).reviewStatus}`;
    return `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;">
          <a href="${pr.url}" style="color:#1d4ed8;text-decoration:none;font-weight:500;">#${pr.number} ${escHtml(pr.title)}</a>
        </td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;color:#6b7280;font-size:13px;white-space:nowrap;">
          ${detail}
        </td>
      </tr>`;
  };

  const wiRow = (wi: WorkItem) => {
    const url = `${AGENT_FORGE_URL}/work-items/${wi.id}`;
    return `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;">
          <a href="${url}" style="color:#1d4ed8;text-decoration:none;">${escHtml(wi.title ?? wi.id)}</a>
        </td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;color:#6b7280;font-size:13px;">${wi.status}</td>
      </tr>`;
  };

  const agentRow = (a: AgentHealth) => {
    const icon = a.healthy ? '🟢' : '🔴';
    const when = a.lastSeen ? fmt(a.lastSeen) : 'never';
    return `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;">${icon} ${escHtml(a.name)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;color:#6b7280;font-size:13px;">Last seen: ${when}</td>
      </tr>`;
  };

  const section = (title: string, content: string) => `
    <div style="margin:24px 0;">
      <h2 style="font-size:16px;font-weight:700;color:#111827;margin:0 0 12px;padding-bottom:6px;border-bottom:2px solid #e5e7eb;">${title}</h2>
      ${content}
    </div>`;

  const table = (rows: string) => `
    <table style="width:100%;border-collapse:collapse;font-size:14px;color:#374151;">
      <tbody>${rows}</tbody>
    </table>`;

  const empty = (msg: string) =>
    `<p style="color:#9ca3af;font-size:13px;margin:4px 0;">${msg}</p>`;

  // Build sections
  const mergedSection = section(
    `📦 Merged PRs (${data.mergedPRs.length})`,
    data.mergedPRs.length > 0
      ? table(data.mergedPRs.map(prRow).join(''))
      : empty('No PRs merged in the last 24 hours.')
  );

  const openSection = section(
    `🔍 Open PRs (${data.openPRs.length})`,
    data.openPRs.length > 0
      ? table(data.openPRs.map(prRow).join(''))
      : empty('No open PRs.')
  );

  const { dispatched, completed, failed, stuck } = data.workItemStats;
  const wiRows = [
    ...completed.map((w) => wiRow(w)),
    ...dispatched.map((w) => wiRow(w)),
    ...failed.map((w) => wiRow(w)),
    ...stuck.map((w) => wiRow(w)),
  ].join('');
  const workSection = section(
    `🗂 Work Items — ${completed.length} completed · ${dispatched.length} active · ${failed.length} failed · ${stuck.length} stuck`,
    wiRows.length > 0 ? table(wiRows) : empty('No work item activity in the last 24 hours.')
  );

  const agentSection = section(
    '🤖 Agent Health',
    table(data.agentHealth.map(agentRow).join(''))
  );

  const escSection = section(
    `🚨 Escalations (${data.escalations.length})`,
    data.escalations.length > 0
      ? table(
          data.escalations
            .map(
              (e) => `
            <tr>
              <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;">
                <a href="${AGENT_FORGE_URL}/work-items/${e.workItemId}" style="color:#1d4ed8;text-decoration:none;">${escHtml(e.reason)}</a>
              </td>
              <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;color:#6b7280;font-size:13px;">${e.status} · ${fmt(e.createdAt)}</td>
            </tr>`
            )
            .join('')
        )
      : empty('No escalations in the last 24 hours.')
  );

  const fbSection =
    data.feedbackProposals.length > 0
      ? section(
          `💡 Feedback Compiler Proposals (${data.feedbackProposals.length})`,
          table(
            data.feedbackProposals
              .map(
                (p) => `
              <tr>
                <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;color:#374151;">${escHtml(p.description)}</td>
                <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;color:#6b7280;font-size:13px;">${fmt(p.createdAt)}</td>
              </tr>`
              )
              .join('')
          )
        )
      : '';

  const topEventTypes = Object.entries(data.eventStats.byType)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(
      ([type, count]) => `
        <tr>
          <td style="padding:4px 8px;color:#374151;font-size:13px;">${escHtml(type)}</td>
          <td style="padding:4px 8px;color:#6b7280;font-size:13px;">${count}</td>
        </tr>`
    )
    .join('');
  const eventsSection = section(
    `📡 Event Bus (${data.eventStats.total} events in 24h)`,
    topEventTypes.length > 0
      ? table(topEventTypes)
      : empty('No events recorded.')
  );

  const healthColor = data.issueCount === 0 ? '#16a34a' : '#d97706';
  const headerBg = data.issueCount === 0 ? '#f0fdf4' : '#fffbeb';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:680px;margin:24px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <!-- Header -->
    <div style="background:#111827;padding:24px 32px;">
      <div style="color:#f9fafb;font-size:20px;font-weight:700;">🔧 Agent Forge</div>
      <div style="color:#9ca3af;font-size:13px;margin-top:4px;">Daily Pipeline Digest · ${fmt(data.generatedAt)}</div>
    </div>
    <!-- Health banner -->
    <div style="background:${headerBg};padding:16px 32px;border-bottom:1px solid #e5e7eb;">
      <span style="font-size:16px;font-weight:600;color:${healthColor};">${escHtml(data.healthSummary)}</span>
    </div>
    <!-- Body -->
    <div style="padding:24px 32px;">
      ${mergedSection}
      ${openSection}
      ${workSection}
      ${agentSection}
      ${escSection}
      ${fbSection}
      ${eventsSection}
    </div>
    <!-- Footer -->
    <div style="background:#f3f4f6;padding:16px 32px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">
      Digest window: ${fmt(data.windowStart)} – ${fmt(data.windowEnd)} ·
      <a href="${AGENT_FORGE_URL}" style="color:#6b7280;">Open Agent Forge</a>
    </div>
  </div>
</body>
</html>`;
}

function escHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
```

### Step 4: Create the cron route

Create `app/api/agents/digest/cron/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { buildDailyDigest, renderDigestHtml } from '@/lib/digest';
// Import the Gmail send function — check lib/gmail.ts for the exact export name
// e.g.: import { sendEmail } from '@/lib/gmail';
// or:   import { sendDigestEmail } from '@/lib/gmail';

export const maxDuration = 60; // Allow up to 60s for API calls

export async function GET(request: Request) {
  // Authenticate via CRON_SECRET (same pattern as other cron routes)
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const digest = await buildDailyDigest();
    const html = renderDigestHtml(digest);

    const recipientEmail = process.env.GMAIL_DIGEST_RECIPIENT ?? 'james.stine.heath@gmail.com';
    const subject = `Agent Forge Daily Digest — ${digest.healthSummary}`;

    // Use the existing Gmail send function — adapt call signature to match lib/gmail.ts
    await sendEmail({
      to: recipientEmail,
      subject,
      html,
    });

    return NextResponse.json({
      ok: true,
      sentAt: digest.generatedAt.toISOString(),
      healthSummary: digest.healthSummary,
      stats: {
        mergedPRs: digest.mergedPRs.length,
        openPRs: digest.openPRs.length,
        workItemsActive: digest.workItemStats.dispatched.length,
        workItemsCompleted: digest.workItemStats.completed.length,
        workItemsFailed: digest.workItemStats.failed.length,
        workItemsStuck: digest.workItemStats.stuck.length,
        escalations: digest.escalations.length,
        events: digest.eventStats.total,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[digest/cron] Error:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
```

**Important:** After reading `lib/gmail.ts` in Step 1, adapt the import and the `sendEmail` call to match the actual exported function name and signature. Common patterns in this codebase:
- `sendEscalationEmail()` — likely needs a new general-purpose `sendEmail()` helper, or you can add one to `lib/gmail.ts`
- If `lib/gmail.ts` only has escalation-specific functions, add a minimal `sendEmail({ to, subject, html }: { to: string; subject: string; html: string })` function there

### Step 5: Register the cron job in `vercel.json`

Read the current `vercel.json` first. Add the daily digest cron entry. The file likely has a `"crons"` array. Add:

```json
{
  "path": "/api/agents/digest/cron",
  "schedule": "0 8 * * *"
}
```

The full crons array should end up looking like the existing entries plus this one. Example (adapt to actual structure):

```json
{
  "crons": [
    { "path": "/api/agents/dispatcher/cron", "schedule": "*/5 * * * *" },
    { "path": "/api/agents/health-monitor/cron", "schedule": "*/5 * * * *" },
    { "path": "/api/pm-agent", "schedule": "*/15 * * * *" },
    { "path": "/api/agents/supervisor/cron", "schedule": "*/10 * * * *" },
    { "path": "/api/agents/digest/cron", "schedule": "0 8 * * *" }
  ]
}
```

### Step 6: Type-check and fix any issues

```bash
npx tsc --noEmit 2>&1
```

Common issues to fix:
- Missing type imports — add them
- `queryEvents` call signature mismatch — adapt to actual API
- `listEscalations` not exported — check the correct export from `lib/escalation.ts`
- `WorkItem` missing `title` or `updatedAt` fields — check `lib/types.ts` and use the correct field names

If `lib/escalation.ts` does not export a list function, check for `listEscalations`, `getEscalations`, or `loadEscalations`. If none exist, use the storage layer directly:

```typescript
import { listBlobs, getBlob } from './storage';
// ...
const escalationKeys = await listBlobs('escalations/');
const escalations = await Promise.all(escalationKeys.map(k => getBlob(k)));
```

Similarly, if `lib/event-bus.ts` doesn't have a time-range query, adapt to use whatever it does export — e.g., `getEvents()`, `readEventLog()`, or direct blob reads.

### Step 7: Build verification

```bash
npm run build 2>&1
```

Fix any build errors that `tsc --noEmit` missed (e.g., missing `maxDuration` export, module resolution issues).

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add daily email digest of pipeline activity

- New lib/digest.ts: builds DigestData from event bus, work items,
  GitHub API, escalations, and agent health
- New app/api/agents/digest/cron/route.ts: renders HTML email and
  sends via Gmail API
- Registers /api/agents/digest/cron at 0 8 * * * in vercel.json
- Health summary line: ✅ All systems healthy / ⚠️ N issues"

git push origin feat/daily-pipeline-digest

gh pr create \
  --title "feat: daily email digest of pipeline activity" \
  --body "## Summary
Adds a daily email digest (8am UTC) summarizing the past 24h of Agent Forge pipeline activity.

## What's included in the digest
- ✅/⚠️ one-line health summary at the top
- PRs merged in last 24h (title, URL, merge time)
- PRs currently open (title, URL, CI status, review status)
- Work items: dispatched, completed, failed, stuck
- Agent health: last-seen timestamp for all 4 agents
- Escalations raised or resolved
- Feedback Compiler proposals (if any)
- Event bus stats (total events + breakdown by type)

## New files
- \`lib/digest.ts\` — data assembly + HTML rendering
- \`app/api/agents/digest/cron/route.ts\` — cron handler, Gmail send

## Modified files
- \`vercel.json\` — added \`0 8 * * *\` cron entry

## Testing
- TypeScript compiles clean (\`npx tsc --noEmit\`)
- \`npm run build\` passes
- Cron can be manually triggered: \`GET /api/agents/digest/cron\` with \`Authorization: Bearer \$CRON_SECRET\`

## Env vars used
- \`CRON_SECRET\` (existing)
- \`GMAIL_CLIENT_ID\`, \`GMAIL_CLIENT_SECRET\`, \`GMAIL_REFRESH_TOKEN\` (existing)
- \`AGENT_FORGE_URL\` (existing)
- \`GMAIL_DIGEST_RECIPIENT\` (optional, defaults to james.stine.heath@gmail.com)
" \
  --base main
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/daily-pipeline-digest
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve (e.g., `lib/gmail.ts` does not have a usable send function, `lib/event-bus.ts` exports are completely different from what's expected, or the `vercel.json` has a conflicting structure):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "daily-pipeline-digest",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/digest.ts", "app/api/agents/digest/cron/route.ts", "vercel.json"]
    }
  }'
```