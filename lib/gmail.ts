import { google } from 'googleapis';
import type { Escalation } from './escalation';
import type { Project, WorkItem, PhaseBreakdown } from './types';
import { loadJson, saveJson } from './storage';

// Gmail client singleton with error handling
let gmailClient: ReturnType<typeof google.gmail> | null = null;
let gmailClientInitialized = false;

function initGmailClient() {
  if (gmailClientInitialized) {
    return gmailClient;
  }

  gmailClientInitialized = true;

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    console.log('[Gmail] Credentials not configured. Escalation emails disabled (graceful degradation).');
    gmailClient = null;
    return null;
  }

  try {
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });

    gmailClient = google.gmail({ version: 'v1', auth });
    console.log('[Gmail] Client initialized successfully.');
    return gmailClient;
  } catch (error) {
    console.error('[Gmail] Failed to initialize client:', error);
    gmailClient = null;
    return null;
  }
}

/**
 * Get authenticated Gmail client, or null if credentials not available
 */
export function getGmailClient() {
  return initGmailClient();
}

/**
 * Send an escalation email for a blocked work item.
 * Returns the Gmail thread ID if sent, null if credentials missing or error.
 */
export async function sendEscalationEmail(
  escalation: Escalation,
  workItem: WorkItem,
  isReminder: boolean = false
): Promise<string | null> {
  // Check rate limit using projectId if available, otherwise workItemId
  const rateLimitId = escalation.projectId ?? escalation.workItemId;
  const isRateLimited = await checkEscalationRateLimit(rateLimitId);
  if (isRateLimited) {
    console.log(`[Gmail] Skipping rate-limited escalation email for ${rateLimitId}`);
    return null;
  }

  const client = getGmailClient();
  if (!client) {
    console.log('[Gmail] Skipping escalation email (credentials not configured).');
    return null;
  }

  try {
    const subject = isReminder
      ? `[Agent Forge] Escalation Reminder: ${workItem.title} (${escalation.reason})`
      : `[Agent Forge] Escalation: ${workItem.title} (${escalation.reason})`;

    const contextSnapshotHtml = formatContextSnapshot(escalation.contextSnapshot);

    const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px; }
    .header { background: #f5f5f5; padding: 15px; border-radius: 4px; margin-bottom: 15px; }
    .header h1 { margin: 0 0 10px 0; font-size: 18px; color: #222; }
    .meta { font-size: 14px; color: #666; }
    .section { margin: 15px 0; }
    .section-title { font-weight: 600; font-size: 14px; color: #222; margin-bottom: 8px; }
    .section-content { background: #fafafa; padding: 12px; border-left: 3px solid #0070f3; border-radius: 4px; font-size: 14px; }
    .score { display: inline-block; background: #fff3cd; color: #856404; padding: 4px 8px; border-radius: 3px; font-size: 12px; font-weight: 600; }
    .context { background: #f0f0f0; padding: 10px; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; overflow-x: auto; }
    .footer { margin-top: 20px; padding-top: 15px; border-top: 1px solid #ddd; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${escapeHtml(workItem.title)}</h1>
      <div class="meta">
        <strong>Status:</strong> Blocked - Agent Forge needs your input
        ${isReminder ? '<br><strong>This is a reminder.</strong> You have 24 hours to resolve.' : ''}
      </div>
    </div>

    <div class="section">
      <div class="section-title">Reason for Escalation</div>
      <div class="section-content">
        ${escapeHtml(escalation.reason)}
      </div>
    </div>

    <div class="section">
      <div class="section-title">Confidence Score</div>
      <div><span class="score">${(escalation.confidenceScore * 100).toFixed(0)}%</span></div>
    </div>

    <div class="section">
      <div class="section-title">Context Snapshot</div>
      <div class="context">${contextSnapshotHtml}</div>
    </div>

    <div class="section">
      <div class="section-title">What to do</div>
      <div class="section-content">
        Reply to this email with your decision:
        <ul>
          <li><strong>Proceed:</strong> "go ahead" or describe how to unblock</li>
          <li><strong>Defer:</strong> "skip for now" or "reschedule"</li>
          <li><strong>Cancel:</strong> "cancel" or explain why this work item is no longer needed</li>
        </ul>
        Agent Forge will detect your reply and auto-resolve this escalation.
      </div>
    </div>

    <div class="footer">
      <p>This is an automated escalation email from Agent Forge. Do not reply with sensitive information.</p>
    </div>
  </div>
</body>
</html>
    `.trim();

    const message = [
      `From: james.stine.heath@gmail.com`,
      `To: james.stine.heath@gmail.com`,
      `Subject: ${subject}`,
      `Content-Type: text/html; charset="UTF-8"`,
      `MIME-Version: 1.0`,
      '',
      htmlBody,
    ].join('\r\n');

    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    const response = await client.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });

    const threadId = response.data.threadId;
    console.log(
      `[Gmail] Escalation email sent for work item "${workItem.title}" (${escalation.id}). Thread ID: ${threadId}`
    );

    // Increment rate limit counters
    await incrementRateLimitCounters(rateLimitId);

    return threadId || null;
  } catch (error) {
    console.error('[Gmail] Failed to send escalation email:', error);
    return null;
  }
}

/**
 * Send a decomposition summary email after a project is broken into work items.
 * Returns the Gmail thread ID if sent, null if credentials missing or error.
 */
export async function sendDecompositionSummary(
  project: Project,
  workItems: WorkItem[],
  phases?: WorkItem[][],
  phaseBreakdown?: PhaseBreakdown,
): Promise<string | null> {
  const client = getGmailClient();
  if (!client) {
    console.log('[Gmail] Skipping decomposition summary (credentials not configured).');
    return null;
  }

  try {
    const totalBudget = workItems.reduce((sum, item) => sum + (item.handoff?.budget ?? 0), 0);

    // Build dependency structure summary
    const depLines = workItems.map((item, idx) => {
      const deps = item.dependencies.length > 0
        ? item.dependencies.map(depId => {
            const dep = workItems.find(w => w.id === depId);
            return dep ? dep.title : depId;
          }).join(', ')
        : 'none';
      return `${idx + 1}. ${escapeHtml(item.title)} → depends on: ${escapeHtml(deps)}`;
    });

    const numPhases = phaseBreakdown?.phases?.length ?? 0;
    const subject = numPhases > 1
      ? `[Agent Forge] Decomposition Complete: ${project.title} (${workItems.length} items across ${numPhases} phases)`
      : `[Agent Forge] Decomposition Complete: ${project.title} (${workItems.length} work items)`;

    const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px; }
    .header { background: #e8f5e9; padding: 15px; border-radius: 4px; margin-bottom: 15px; }
    .header h1 { margin: 0 0 10px 0; font-size: 18px; color: #222; }
    .meta { font-size: 14px; color: #666; }
    .section { margin: 15px 0; }
    .section-title { font-weight: 600; font-size: 14px; color: #222; margin-bottom: 8px; }
    .section-content { background: #fafafa; padding: 12px; border-left: 3px solid #4caf50; border-radius: 4px; font-size: 14px; }
    .dep-list { font-family: 'Courier New', monospace; font-size: 13px; line-height: 1.8; }
    .footer { margin-top: 20px; padding-top: 15px; border-top: 1px solid #ddd; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${escapeHtml(project.title)}</h1>
      <div class="meta">
        <strong>Project ID:</strong> ${escapeHtml(project.projectId)}<br>
        <strong>Status:</strong> Decomposition complete
      </div>
    </div>

    <div class="section">
      <div class="section-title">Summary</div>
      <div class="section-content">
        <strong>${workItems.length}</strong> work items created<br>
        <strong>Estimated total budget:</strong> $${totalBudget.toFixed(2)}
      </div>
    </div>

    <div class="section">
      <div class="section-title">Dependency Structure</div>
      <div class="section-content dep-list">
        ${depLines.join('<br>')}
      </div>
    </div>

    ${numPhases > 1 ? phaseBreakdown!.phases.map((phase, idx) => `
    <div class="section">
      <div class="section-title">Phase ${idx + 1}: ${escapeHtml(phase.name)} (${phase.itemCount} items)</div>
      ${(() => {
        const phaseDeps = phaseBreakdown!.crossPhaseDeps
          .filter((d) => d.from === phase.id)
          .map((d) => {
            const target = phaseBreakdown!.phases.find((p) => p.id === d.to);
            return target ? escapeHtml(target.name) : d.to;
          });
        return phaseDeps.length > 0
          ? `<p style="color: #666; font-size: 13px; margin: 0 0 8px 0;">Depends on: ${phaseDeps.join(', ')}</p>`
          : '';
      })()}
      <div class="section-content">
        <ul style="margin: 0; padding-left: 20px;">
          ${phase.items.map((item) => `<li>${escapeHtml(item.title)} (${escapeHtml(item.priority)} priority)</li>`).join('\n          ')}
        </ul>
      </div>
    </div>`).join('') : phases && phases.length > 1 ? `
    <div class="section">
      <div class="section-title">Phase Structure</div>
      <div class="section-content dep-list">
        ${phases.map((phase, idx) => `<strong>Phase ${idx + 1}</strong> (${phase.length} items)<br>${phase.map((item) => `&nbsp;&nbsp;- ${escapeHtml(item.title)}`).join('<br>')}`).join('<br><br>')}
      </div>
    </div>
    ` : ''}

    ${numPhases > 1 && phaseBreakdown!.crossPhaseDeps.length > 0 ? `
    <div class="section">
      <div class="section-title">Cross-Phase Dependencies</div>
      <div class="section-content">
        <ul style="margin: 0; padding-left: 20px;">
          ${phaseBreakdown!.crossPhaseDeps.map((dep) => {
            const fromPhase = phaseBreakdown!.phases.find((p) => p.id === dep.from);
            const toPhase = phaseBreakdown!.phases.find((p) => p.id === dep.to);
            return `<li>${escapeHtml(fromPhase?.name ?? dep.from)} depends on ${escapeHtml(toPhase?.name ?? dep.to)}</li>`;
          }).join('\n          ')}
        </ul>
      </div>
    </div>
    ` : ''}

    <div class="section">
      <div class="section-title">Cost Breakdown</div>
      <div class="section-content">
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <tr style="border-bottom:1px solid #e0e0e0;">
            <th style="text-align:left; padding:4px 0;">Work Item</th>
            <th style="text-align:right; padding:4px 0;">Budget</th>
          </tr>
          ${workItems.map((item) => `<tr style="border-bottom:1px solid #f0f0f0;">
            <td style="padding:4px 0;">${escapeHtml(item.title)}</td>
            <td style="text-align:right; padding:4px 0;">${item.handoff?.budget != null ? '$' + item.handoff.budget.toFixed(2) : '\u2014'}</td>
          </tr>`).join('')}
          <tr style="font-weight:600;">
            <td style="padding:6px 0 0;">Total</td>
            <td style="text-align:right; padding:6px 0 0;">$${totalBudget.toFixed(2)}</td>
          </tr>
        </table>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Dashboard</div>
      <div class="section-content">
        View project status on the <a href="https://agent-forge.vercel.app/pipeline">Agent Forge Dashboard</a>.
      </div>
    </div>

    <div class="footer">
      <p>This is an automated notification from Agent Forge.</p>
    </div>
  </div>
</body>
</html>
    `.trim();

    const message = [
      `From: james.stine.heath@gmail.com`,
      `To: james.stine.heath@gmail.com`,
      `Subject: ${subject}`,
      `Content-Type: text/html; charset="UTF-8"`,
      `MIME-Version: 1.0`,
      '',
      htmlBody,
    ].join('\r\n');

    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    const response = await client.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });

    const threadId = response.data.threadId;
    console.log(
      `[Gmail] Decomposition summary sent for project "${project.title}" (${project.projectId}). Thread ID: ${threadId}`
    );

    return threadId || null;
  } catch (error) {
    console.error('[Gmail] Failed to send decomposition summary:', error);
    return null;
  }
}

/**
 * Send a plain-text email via Gmail.
 * Returns the Gmail thread ID if sent, null if credentials missing or error.
 */
export async function sendEmail({
  subject,
  body,
}: {
  subject: string;
  body: string;
}): Promise<string | null> {
  const client = getGmailClient();
  if (!client) {
    console.log('[Gmail] Skipping email (credentials not configured).');
    return null;
  }

  try {
    const message = [
      `From: james.stine.heath@gmail.com`,
      `To: james.stine.heath@gmail.com`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `MIME-Version: 1.0`,
      '',
      body,
    ].join('\r\n');

    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    const response = await client.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });

    const threadId = response.data.threadId;
    console.log(`[Gmail] Email sent: "${subject}". Thread ID: ${threadId}`);
    return threadId || null;
  } catch (error) {
    console.error('[Gmail] Failed to send email:', error);
    return null;
  }
}

/**
 * Check if a reply exists in an escalation thread.
 * Returns the reply message object if found, null otherwise.
 */
export async function checkForReply(threadId: string): Promise<{ id: string } | null> {
  const client = getGmailClient();
  if (!client) {
    return null;
  }

  try {
    const response = await client.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'metadata',
    });

    const messages = response.data.messages || [];
    if (messages.length <= 1) {
      // Only the original escalation email, no reply yet
      return null;
    }

    // Return the last message (most recent reply)
    const lastMessage = messages[messages.length - 1];
    return lastMessage?.id ? { id: lastMessage.id } : null;
  } catch (error) {
    console.error(`[Gmail] Failed to check for reply on thread ${threadId}:`, error);
    return null;
  }
}

/**
 * Parse the reply content from a Gmail message.
 * Strips quoted content and extracts just the new reply text.
 */
export async function parseReplyContent(messageId: string): Promise<string> {
  const client = getGmailClient();
  if (!client) {
    return '';
  }

  try {
    const response = await client.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const message = response.data;
    const parts = message.payload?.parts || [];

    // Extract text from parts
    let text = '';
    if (parts.length > 0) {
      for (const part of parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          text = Buffer.from(part.body.data, 'base64').toString('utf-8');
          break;
        }
      }
    } else if (message.payload?.body?.data) {
      text = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
    }

    // Strip quoted content (lines starting with ">")
    const lines = text.split('\n');
    const replyLines = [];
    for (const line of lines) {
      if (line.startsWith('>')) {
        continue; // Skip quoted content
      }
      replyLines.push(line);
    }

    const cleaned = replyLines.join('\n').trim();
    return cleaned || '';
  } catch (error) {
    console.error(`[Gmail] Failed to parse reply content from message ${messageId}:`, error);
    return '';
  }
}

// --- Escalation email dedup & rate limiting ---

interface DedupRecord {
  sentAt: string;
}

interface RateLimitCounter {
  count: number;
  hourStart: string;
}

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RATE_LIMIT_PER_PROJECT_PER_HOUR = 3;
const RATE_LIMIT_GLOBAL_PER_HOUR = 10;

function getDedupKey(projectId: string, escalationType: string): string {
  return `project-escalation:${projectId}:${escalationType}`;
}

function getRateLimitKey(projectId: string): string {
  return `escalation-rate:${projectId}`;
}

const GLOBAL_RATE_KEY = 'escalation-rate:global';

function getCurrentHourStart(): string {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  return now.toISOString();
}

/**
 * Check if a project escalation email was already sent within the dedup window.
 * Returns true if a duplicate exists (email should be skipped).
 */
export async function checkEscalationDedup(projectId: string, escalationType: string): Promise<boolean> {
  const key = getDedupKey(projectId, escalationType);
  const record = await loadJson<DedupRecord>(key);
  if (!record) return false;

  const age = Date.now() - new Date(record.sentAt).getTime();
  if (age < DEDUP_TTL_MS) {
    return true; // duplicate within window
  }
  return false;
}

/**
 * Record that an escalation email was sent for dedup tracking.
 */
async function recordEscalationSent(projectId: string, escalationType: string): Promise<void> {
  const key = getDedupKey(projectId, escalationType);
  await saveJson<DedupRecord>(key, { sentAt: new Date().toISOString() });
}

/**
 * Check escalation rate limits for a project.
 * Enforces max 3 per project per hour and max 10 total per hour.
 * Returns true if rate limited (email should be skipped).
 */
export async function checkEscalationRateLimit(projectId: string): Promise<boolean> {
  const hourStart = getCurrentHourStart();

  // Check per-project limit
  const projectKey = getRateLimitKey(projectId);
  const projectCounter = await loadJson<RateLimitCounter>(projectKey);
  if (projectCounter && projectCounter.hourStart === hourStart) {
    if (projectCounter.count >= RATE_LIMIT_PER_PROJECT_PER_HOUR) {
      console.log(`[Gmail] Rate limited: project ${projectId} has sent ${projectCounter.count} escalation emails this hour`);
      return true;
    }
  }

  // Check global limit
  const globalCounter = await loadJson<RateLimitCounter>(GLOBAL_RATE_KEY);
  if (globalCounter && globalCounter.hourStart === hourStart) {
    if (globalCounter.count >= RATE_LIMIT_GLOBAL_PER_HOUR) {
      console.log(`[Gmail] Rate limited: ${globalCounter.count} total escalation emails sent this hour`);
      return true;
    }
  }

  return false;
}

/**
 * Increment rate limit counters after sending an escalation email.
 */
async function incrementRateLimitCounters(projectId: string): Promise<void> {
  const hourStart = getCurrentHourStart();

  // Increment per-project counter
  const projectKey = getRateLimitKey(projectId);
  const projectCounter = await loadJson<RateLimitCounter>(projectKey);
  if (projectCounter && projectCounter.hourStart === hourStart) {
    await saveJson<RateLimitCounter>(projectKey, { count: projectCounter.count + 1, hourStart });
  } else {
    await saveJson<RateLimitCounter>(projectKey, { count: 1, hourStart });
  }

  // Increment global counter
  const globalCounter = await loadJson<RateLimitCounter>(GLOBAL_RATE_KEY);
  if (globalCounter && globalCounter.hourStart === hourStart) {
    await saveJson<RateLimitCounter>(GLOBAL_RATE_KEY, { count: globalCounter.count + 1, hourStart });
  } else {
    await saveJson<RateLimitCounter>(GLOBAL_RATE_KEY, { count: 1, hourStart });
  }
}

/**
 * Send a project-level escalation email.
 * Returns true on successful send, false if credentials are missing or send fails.
 * Includes dedup (24h window per project+type) and rate limiting (3/project/hr, 10 global/hr).
 */
export async function sendProjectEscalationEmail(params: {
  projectId: string;
  projectTitle: string;
  reason: string;
  context?: string;
  escalationType: string;
}): Promise<boolean> {
  // Check dedup: skip if same project+type email sent within 24h
  const isDuplicate = await checkEscalationDedup(params.projectId, params.escalationType);
  if (isDuplicate) {
    console.log(`[Gmail] Skipping duplicate escalation email for project ${params.projectId} (type: ${params.escalationType})`);
    return false;
  }

  // Check rate limit
  const isRateLimited = await checkEscalationRateLimit(params.projectId);
  if (isRateLimited) {
    console.log(`[Gmail] Skipping rate-limited escalation email for project ${params.projectId}`);
    return false;
  }

  const client = getGmailClient();
  if (!client) {
    console.log('[Gmail] Skipping project escalation email (credentials not configured).');
    return false;
  }

  try {
    const subject = `[Agent Forge] Project Escalation: ${params.projectTitle}`;

    const contextSection = params.context
      ? `\n    <div class="section">
      <div class="section-title">Additional Context</div>
      <div class="section-content">${escapeHtml(params.context)}</div>
    </div>`
      : '';

    const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px; }
    .header { background: #fff3cd; padding: 15px; border-radius: 4px; margin-bottom: 15px; }
    .header h1 { margin: 0 0 10px 0; font-size: 18px; color: #222; }
    .meta { font-size: 14px; color: #666; }
    .section { margin: 15px 0; }
    .section-title { font-weight: 600; font-size: 14px; color: #222; margin-bottom: 8px; }
    .section-content { background: #fafafa; padding: 12px; border-left: 3px solid #f0ad4e; border-radius: 4px; font-size: 14px; }
    .footer { margin-top: 20px; padding-top: 15px; border-top: 1px solid #ddd; font-size: 12px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Agent Forge – Project Escalation</h1>
      <div class="meta">
        <strong>Project:</strong> ${escapeHtml(params.projectTitle)}<br>
        <strong>Project ID:</strong> ${escapeHtml(params.projectId)}<br>
        <strong>Escalation Type:</strong> ${escapeHtml(params.escalationType)}
      </div>
    </div>

    <div class="section">
      <div class="section-title">Reason</div>
      <div class="section-content">${escapeHtml(params.reason)}</div>
    </div>
    ${contextSection}

    <div class="footer">
      <p>This is an automated notification from Agent Forge.</p>
    </div>
  </div>
</body>
</html>
    `.trim();

    const message = [
      `From: james.stine.heath@gmail.com`,
      `To: james.stine.heath@gmail.com`,
      `Subject: ${subject}`,
      `Content-Type: text/html; charset="UTF-8"`,
      `MIME-Version: 1.0`,
      '',
      htmlBody,
    ].join('\r\n');

    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    const response = await client.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });

    console.log(
      `[Gmail] Project escalation email sent for "${params.projectTitle}" (${params.projectId}). Thread ID: ${response.data.threadId}`
    );

    // Record dedup and increment rate limit counters
    await recordEscalationSent(params.projectId, params.escalationType);
    await incrementRateLimitCounters(params.projectId);

    return true;
  } catch (error) {
    console.error('[Gmail] Failed to send project escalation email:', error);
    return false;
  }
}

/**
 * Format context snapshot for HTML email display
 */
function formatContextSnapshot(snapshot: Record<string, unknown>): string {
  if (!snapshot) {
    return '(no context available)';
  }

  const lines: string[] = [];
  if (typeof snapshot === 'string') {
    return escapeHtml(snapshot);
  }

  if (typeof snapshot === 'object') {
    for (const [key, value] of Object.entries(snapshot)) {
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      lines.push(`${key}: ${valueStr}`);
    }
  }

  return escapeHtml(lines.join('\n'));
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}
