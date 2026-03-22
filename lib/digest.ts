import { listWorkItems } from './work-items';
import { listEscalations } from './escalation';
import { queryEvents } from './event-bus';
import { getATCEvents } from './atc/events';
import { listPullRequests, getPullRequestChecks } from './github';
import { getSecurityOverview } from './security';
import { listRepos } from './repos';
import type { SecurityOverview } from './security';
import type { WorkItemIndexEntry } from './types';
import type { ATCEvent } from './types';
import type { Escalation } from './escalation';
import type { PRSummary } from './github';
import type { WebhookEvent } from './event-bus-types';

const AGENT_FORGE_URL = process.env.AGENT_FORGE_URL ?? 'https://agent-forge.vercel.app';
const REPO = 'jamesstineheath/agent-forge';

// --- Types ---

export interface AgentHealth {
  name: string;
  lastSeen: Date | null;
  healthy: boolean;
}

export interface DigestData {
  generatedAt: Date;
  windowStart: Date;
  windowEnd: Date;
  mergedPRs: DigestMergedPR[];
  openPRs: DigestOpenPR[];
  workItemStats: WorkItemStats;
  agentHealth: AgentHealth[];
  escalations: EscalationSummary[];
  feedbackProposals: FeedbackProposal[];
  eventStats: EventStats;
  securityOverview: SecurityOverview | null;
  issueCount: number;
  healthSummary: string;
}

export interface DigestMergedPR {
  number: number;
  title: string;
  url: string;
  repo: string;
  mergedAt: string;
}

export interface DigestOpenPR {
  number: number;
  title: string;
  url: string;
  repo: string;
  ciStatus: 'passing' | 'failing' | 'pending' | 'unknown';
  reviewStatus: string;
  createdAt: string;
}

export interface WorkItemStats {
  dispatched: WorkItemIndexEntry[];
  completed: WorkItemIndexEntry[];
  failed: WorkItemIndexEntry[];
  stuck: WorkItemIndexEntry[];
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

// Map ATC event types to agents
const AGENT_EVENT_TYPES: Record<string, ATCEvent['type'][]> = {
  Dispatcher: ['auto_dispatch'],
  HealthMonitor: ['timeout', 'retry', 'cleanup', 'work_item_reconciled', 'status_change'],
  ProjectManager: ['project_trigger', 'project_completion', 'dependency_block', 'dep_resolved'],
  Supervisor: ['escalation', 'escalation_timeout', 'escalation_resolved', 'auto_cancel', 'project_retry'],
};

// --- Data Assembly ---

export async function buildDailyDigest(): Promise<DigestData> {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);

  // 1. Query event bus for last 24h (webhook events)
  const events = await queryEvents({
    since: windowStart.toISOString(),
    limit: 5000,
  });

  // 2. Work item stats from index
  const allWorkItems = await listWorkItems();
  const recentlyUpdated = allWorkItems.filter((wi) => {
    const updatedAt = new Date(wi.updatedAt);
    return updatedAt >= windowStart;
  });

  const dispatched = recentlyUpdated.filter((wi) =>
    ['queued', 'generating', 'executing'].includes(wi.status)
  );
  const completed = recentlyUpdated.filter((wi) => wi.status === 'merged');
  const failed = recentlyUpdated.filter((wi) =>
    ['failed', 'parked'].includes(wi.status)
  );
  // Stuck = executing/reviewing/generating for > 2 hours
  const twoHoursAgo = new Date(windowEnd.getTime() - 2 * 60 * 60 * 1000);
  const stuck = allWorkItems.filter((wi) => {
    if (!['executing', 'reviewing', 'generating'].includes(wi.status)) return false;
    const updatedAt = new Date(wi.updatedAt);
    return updatedAt < twoHoursAgo;
  });

  // 3. Agent health from ATC events
  const atcEvents = await getATCEvents(1000);
  const agentNames = Object.keys(AGENT_EVENT_TYPES);
  const agentHealth: AgentHealth[] = agentNames.map((name) => {
    const relevantTypes = AGENT_EVENT_TYPES[name];
    const agentEvents = atcEvents.filter((e) => relevantTypes.includes(e.type));
    const lastSeen =
      agentEvents.length > 0
        ? new Date(Math.max(...agentEvents.map((e) => new Date(e.timestamp).getTime())))
        : null;
    return {
      name,
      lastSeen,
      healthy: lastSeen !== null && lastSeen >= windowStart,
    };
  });

  // 4. Escalations
  const allEscalations = await listEscalations('all');
  const recentEscalations: EscalationSummary[] = allEscalations
    .filter((e: Escalation) => new Date(e.createdAt) >= windowStart)
    .map((e: Escalation) => ({
      id: e.id,
      reason: e.reason,
      status: e.status,
      workItemId: e.workItemId,
      createdAt: e.createdAt,
    }));

  // 5. GitHub PRs
  const [closedPRs, openPRsRaw] = await Promise.all([
    listPullRequests(REPO, { state: 'closed', perPage: 50 }),
    listPullRequests(REPO, { state: 'open', perPage: 50 }),
  ]);

  const mergedPRs: DigestMergedPR[] = closedPRs
    .filter((pr: PRSummary) => pr.merged_at && new Date(pr.merged_at) >= windowStart)
    .map((pr: PRSummary) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      repo: 'agent-forge',
      mergedAt: pr.merged_at!,
    }));

  const openPRs: DigestOpenPR[] = await Promise.all(
    openPRsRaw.map(async (pr: PRSummary) => {
      let ciStatus: DigestOpenPR['ciStatus'] = 'unknown';
      try {
        const { checks } = await getPullRequestChecks(REPO, pr.number);
        if (checks.length === 0) ciStatus = 'unknown';
        else if (checks.every((c) => c.conclusion === 'success')) ciStatus = 'passing';
        else if (checks.some((c) => c.conclusion === 'failure')) ciStatus = 'failing';
        else ciStatus = 'pending';
      } catch {
        ciStatus = 'unknown';
      }
      return {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        repo: 'agent-forge',
        ciStatus,
        reviewStatus: pr.draft ? 'draft' : 'open',
        createdAt: pr.created_at,
      };
    })
  );

  // 6. Feedback proposals from webhook events
  const feedbackEvents = events.filter(
    (e: WebhookEvent) =>
      e.type.toLowerCase().includes('feedback') ||
      e.type.toLowerCase().includes('proposal')
  );
  const feedbackProposals: FeedbackProposal[] = feedbackEvents.map((e: WebhookEvent) => ({
    description: e.payload?.summary ?? e.type,
    createdAt: e.timestamp,
  }));

  // 7. Event stats (combine webhook events + ATC events)
  const webhookStats: Record<string, number> = {};
  for (const e of events) {
    webhookStats[e.type] = (webhookStats[e.type] ?? 0) + 1;
  }
  const atcStats: Record<string, number> = {};
  const recentAtcEvents = atcEvents.filter(
    (e) => new Date(e.timestamp) >= windowStart
  );
  for (const e of recentAtcEvents) {
    const key = `atc.${e.type}`;
    atcStats[key] = (atcStats[key] ?? 0) + 1;
  }
  const byType = { ...webhookStats, ...atcStats };
  const eventStats: EventStats = {
    total: events.length + recentAtcEvents.length,
    byType,
  };

  // 8. Security alerts
  let securityOverview: SecurityOverview | null = null;
  try {
    const repoIndex = await listRepos();
    const repoNames = repoIndex.map((r) => r.fullName);
    if (repoNames.length > 0) {
      securityOverview = await getSecurityOverview(repoNames);
    }
  } catch (err) {
    console.warn('[digest] Failed to fetch security alerts:', err);
  }

  // 9. Health summary
  const unhealthyAgents = agentHealth.filter((a) => !a.healthy);
  const issueCount =
    failed.length +
    stuck.length +
    recentEscalations.filter((e) => e.status === 'pending').length +
    unhealthyAgents.length;

  const healthSummary =
    issueCount === 0
      ? '\u2705 All systems healthy'
      : `\u26A0\uFE0F ${issueCount} issue${issueCount === 1 ? '' : 's'} need${issueCount === 1 ? 's' : ''} attention`;

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
    securityOverview,
    issueCount,
    healthSummary,
  };
}

// --- HTML Renderer ---

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

  const prRow = (pr: DigestMergedPR | DigestOpenPR) => {
    const isMerged = 'mergedAt' in pr;
    const detail = isMerged
      ? `Merged ${fmt((pr as DigestMergedPR).mergedAt)}`
      : `CI: ${statusBadge((pr as DigestOpenPR).ciStatus)} &middot; ${(pr as DigestOpenPR).reviewStatus}`;
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

  const wiRow = (wi: WorkItemIndexEntry) => {
    const url = `${AGENT_FORGE_URL}/work-items/${wi.id}`;
    return `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;">
          <a href="${url}" style="color:#1d4ed8;text-decoration:none;">${escHtml(wi.title)}</a>
        </td>
        <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;color:#6b7280;font-size:13px;">${wi.status}</td>
      </tr>`;
  };

  const agentRow = (a: AgentHealth) => {
    const icon = a.healthy ? '\uD83D\uDFE2' : '\uD83D\uDD34';
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
    `\uD83D\uDCE6 Merged PRs (${data.mergedPRs.length})`,
    data.mergedPRs.length > 0
      ? table(data.mergedPRs.map(prRow).join(''))
      : empty('No PRs merged in the last 24 hours.')
  );

  const openSection = section(
    `\uD83D\uDD0D Open PRs (${data.openPRs.length})`,
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
    `\uD83D\uDDC2 Work Items \u2014 ${completed.length} completed \u00B7 ${dispatched.length} active \u00B7 ${failed.length} failed \u00B7 ${stuck.length} stuck`,
    wiRows.length > 0 ? table(wiRows) : empty('No work item activity in the last 24 hours.')
  );

  const agentSection = section(
    '\uD83E\uDD16 Agent Health',
    table(data.agentHealth.map(agentRow).join(''))
  );

  const escSection = section(
    `\uD83D\uDEA8 Escalations (${data.escalations.length})`,
    data.escalations.length > 0
      ? table(
          data.escalations
            .map(
              (e) => `
            <tr>
              <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;">
                <a href="${AGENT_FORGE_URL}/work-items/${e.workItemId}" style="color:#1d4ed8;text-decoration:none;">${escHtml(e.reason)}</a>
              </td>
              <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;color:#6b7280;font-size:13px;">${e.status} &middot; ${fmt(e.createdAt)}</td>
            </tr>`
            )
            .join('')
        )
      : empty('No escalations in the last 24 hours.')
  );

  const fbSection =
    data.feedbackProposals.length > 0
      ? section(
          `\uD83D\uDCA1 Feedback Compiler Proposals (${data.feedbackProposals.length})`,
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

  // Security section
  let securitySection = '';
  if (data.securityOverview && data.securityOverview.totalAlerts > 0) {
    const secRows = data.securityOverview.repos
      .filter((r) => r.totalOpen > 0)
      .map((r) => {
        const repoShort = r.repo.split('/').pop() ?? r.repo;
        const depTotal = r.dependabot.critical + r.dependabot.high + r.dependabot.medium + r.dependabot.low;
        const csTotal = r.codeScanning.critical + r.codeScanning.high + r.codeScanning.medium + r.codeScanning.low;
        const parts = [];
        if (depTotal > 0) parts.push(`Dependabot: ${depTotal}`);
        if (csTotal > 0) parts.push(`CodeQL: ${csTotal}`);
        if (r.secretScanning.open > 0) parts.push(`Secrets: ${r.secretScanning.open}`);
        return `
          <tr>
            <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-weight:500;">${escHtml(repoShort)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;color:#6b7280;font-size:13px;">${parts.join(' &middot; ')}</td>
          </tr>`;
      })
      .join('');
    securitySection = section(
      `\uD83D\uDEE1 Security Alerts (${data.securityOverview.totalAlerts} open)`,
      table(secRows)
    );
  }

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
    `\uD83D\uDCE1 Event Bus (${data.eventStats.total} events in 24h)`,
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
      <div style="color:#f9fafb;font-size:20px;font-weight:700;">\uD83D\uDD27 Agent Forge</div>
      <div style="color:#9ca3af;font-size:13px;margin-top:4px;">Daily Pipeline Digest \u00B7 ${fmt(data.generatedAt)}</div>
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
      ${securitySection}
      ${agentSection}
      ${escSection}
      ${fbSection}
      ${eventsSection}
    </div>
    <!-- Footer -->
    <div style="background:#f3f4f6;padding:16px 32px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">
      Digest window: ${fmt(data.windowStart)} \u2013 ${fmt(data.windowEnd)} &middot;
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
