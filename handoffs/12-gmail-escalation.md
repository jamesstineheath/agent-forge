# Handoff 12: Gmail Integration for Escalation

## Metadata
- **Branch:** `feat/gmail-escalation`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $8
- **Risk Level:** medium
- **Blocks:** ATC polling for escalation resolution
- **Depends on:** Handoff 11 (Escalation State Machine)

## Context

Agent Forge escalates blocked work items to James via email. When a work item cannot proceed, an escalation is recorded with reason and confidence score. This handoff wires Gmail API into the escalation system to:

1. Send structured escalation emails to `james.stine.heath@gmail.com` when escalations are created
2. Poll Gmail for replies to those escalation threads
3. Auto-resolve escalations when James replies with instructions
4. Send reminder emails for escalations older than 24 hours

**Assumes Handoff 11 complete:**
- `lib/escalation.ts` exists with `escalate()`, `resolveEscalation()`, `getPendingEscalations()`, `listEscalations()`, `getEscalation()`
- `Escalation` interface: `id, workItemId, reason, confidenceScore, contextSnapshot, status ("pending"|"resolved"|"expired"), createdAt, resolvedAt?, resolution?, threadId?`
- `WorkItem` has `"blocked"` status and `escalation?: { id, reason, blockedAt }` field
- `/api/escalations` and `/api/escalations/[id]/resolve` routes exist
- ATC monitor exists in `lib/atc.ts`

**Gmail API approach:**
- Separate OAuth2 credentials for Agent Forge (not PA's)
- Uses `googleapis` npm package
- Graceful degradation: if env vars missing, escalations still work but no emails sent
- Self-email pattern: escalation emails sent FROM and TO `james.stine.heath@gmail.com`

**Required environment variables (set in Vercel):**
- `GMAIL_CLIENT_ID` - OAuth2 client ID
- `GMAIL_CLIENT_SECRET` - OAuth2 client secret
- `GMAIL_REFRESH_TOKEN` - OAuth2 refresh token for james.stine.heath@gmail.com

## Pre-flight Self-Check

Before starting:
- [ ] Handoff 11 (Escalation State Machine) is merged to main
- [ ] Local checkout of `jamesstineheath/agent-forge` exists
- [ ] Running Node 20+ (check: `node -v`)
- [ ] `npm` or `pnpm` available
- [ ] No uncommitted changes in working tree
- [ ] Understand Handoff 11 escalation flow: `escalate()` -> work item blocked -> ATC monitors
- [ ] Gmail API docs reviewed: https://developers.google.com/gmail/api/reference/rest

## Step 0: Branch setup

Create and switch to feature branch:

```bash
cd /path/to/jamesstineheath/agent-forge
git fetch origin main
git checkout -b feat/gmail-escalation origin/main
```

Install `googleapis` dependency:

```bash
npm install googleapis
# or: pnpm add googleapis
```

## Step 1: Create `lib/gmail.ts` - Gmail API client wrapper

This is the complete file content for the new Gmail integration module:

```typescript
import { google } from 'googleapis';
import { Escalation } from './escalation';
import { WorkItem } from './database';

// Gmail client singleton with error handling
let gmailClient: InstanceType<typeof google.gmail> | null = null;
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
    .cta { background: #0070f3; color: white; padding: 10px 20px; border-radius: 4px; display: inline-block; text-decoration: none; margin-top: 10px; }
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

    return threadId || null;
  } catch (error) {
    console.error('[Gmail] Failed to send escalation email:', error);
    return null;
  }
}

/**
 * Check if a reply exists in an escalation thread.
 * Returns the reply message object if found, null otherwise.
 */
export async function checkForReply(threadId: string): Promise<any | null> {
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
    return messages[messages.length - 1];
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
    const headers = message.payload?.headers || [];
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

/**
 * Format context snapshot for HTML email display
 */
function formatContextSnapshot(snapshot: any): string {
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
```

## Step 2: Create `app/api/escalations/test-email/route.ts` - Test endpoint

This endpoint allows testing Gmail setup without creating a real escalation. Use only in development or with auth token:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { sendEscalationEmail } from '@/lib/gmail';

export async function POST(request: NextRequest) {
  // Only allow in development or with dev query param
  const isDev = process.env.NODE_ENV === 'development';
  const hasDevParam = request.nextUrl.searchParams.get('dev') === 'true';

  if (!isDev && !hasDevParam) {
    return NextResponse.json({ error: 'Test endpoint not available' }, { status: 403 });
  }

  try {
    const body = await request.json();

    // Use provided work item or create a mock
    const workItem = body.workItem || {
      id: 'test-work-item',
      title: body.title || 'Test Work Item',
      status: 'blocked',
    };

    const escalation = body.escalation || {
      id: 'test-escalation-' + Date.now(),
      workItemId: workItem.id,
      reason: body.reason || 'Test escalation via API',
      confidenceScore: 0.95,
      contextSnapshot: {
        endpoint: '/api/escalations/test-email',
        timestamp: new Date().toISOString(),
        testRun: true,
      },
      status: 'pending',
      createdAt: new Date(),
    };

    const threadId = await sendEscalationEmail(escalation, workItem);

    if (threadId) {
      return NextResponse.json(
        {
          success: true,
          message: 'Test escalation email sent successfully',
          threadId,
          escalation,
        },
        { status: 200 }
      );
    } else {
      return NextResponse.json(
        {
          success: false,
          message: 'Gmail credentials not configured. Email not sent. (Graceful degradation mode)',
          escalation,
        },
        { status: 200 }
      );
    }
  } catch (error) {
    console.error('[Test Email] Error:', error);
    return NextResponse.json(
      { error: 'Failed to send test email', details: String(error) },
      { status: 500 }
    );
  }
}
```

## Step 3: Modify `lib/escalation.ts` - Wire Gmail into escalation creation

**Find the `escalate()` function and update it:**

Look for:
```typescript
export async function escalate(
  workItemId: string,
  reason: string,
  confidenceScore: number,
  contextSnapshot: any
): Promise<Escalation> {
```

Replace the entire function body with:

```typescript
export async function escalate(
  workItemId: string,
  reason: string,
  confidenceScore: number,
  contextSnapshot: any
): Promise<Escalation> {
  const id = generateId('esc');
  const now = new Date();

  const escalation: Escalation = {
    id,
    workItemId,
    reason,
    confidenceScore,
    contextSnapshot,
    status: 'pending',
    createdAt: now,
  };

  // Save escalation to Blob storage
  await put(`escalations/${id}.json`, JSON.stringify(escalation));

  // Update work item status to "blocked"
  const workItem = await getWorkItem(workItemId);
  if (workItem) {
    workItem.status = 'blocked';
    workItem.escalation = {
      id,
      reason,
      blockedAt: now,
    };
    await put(`work-items/${workItemId}.json`, JSON.stringify(workItem));
  }

  // Attempt to send escalation email via Gmail
  const { sendEscalationEmail } = await import('./gmail');
  if (workItem) {
    const threadId = await sendEscalationEmail(escalation, workItem);
    if (threadId) {
      // Update escalation with thread ID
      await updateEscalation(id, { threadId });
    }
  }

  console.log(`[Escalation] Created escalation ${id} for work item ${workItemId}`);
  return escalation;
}
```

**Also add the `updateEscalation()` helper if not already present:**

Add this function after the `escalate()` function:

```typescript
/**
 * Update an escalation record with partial data
 */
export async function updateEscalation(
  id: string,
  patch: Partial<Escalation>
): Promise<Escalation | null> {
  try {
    const escalation = await getEscalation(id);
    if (!escalation) return null;

    const updated = { ...escalation, ...patch };
    await put(`escalations/${id}.json`, JSON.stringify(updated));
    return updated;
  } catch (error) {
    console.error(`[Escalation] Failed to update escalation ${id}:`, error);
    return null;
  }
}
```

## Step 4: Modify `lib/atc.ts` - Add Gmail reply polling

**Find the ATC sweep function. It should have sections numbered 1-10. Add sections 11 and 12 after the existing sections.**

Look for the comment or section that says `// Section 10: Monitor escalation timeouts` (or similar).

After that section (before the final `await recordATCEvent`), add:

```typescript
  // Section 11: Poll Gmail for escalation replies
  console.log('[ATC] Section 11: Polling Gmail for escalation replies...');
  const pendingEscalations = await getPendingEscalations();
  const { checkForReply, parseReplyContent } = await import('./gmail');

  for (const escalation of pendingEscalations) {
    if (!escalation.threadId) {
      // No thread ID means email was not sent (graceful degradation)
      continue;
    }

    const replyMessage = await checkForReply(escalation.threadId);
    if (replyMessage) {
      // Reply found! Parse content and resolve
      const replyContent = await parseReplyContent(replyMessage.id);
      console.log(`[ATC] Found reply to escalation ${escalation.id}:`, replyContent);

      const resolved = await resolveEscalation(escalation.id, replyContent);
      if (resolved) {
        await recordATCEvent({
          type: 'escalation_resolved',
          escalationId: escalation.id,
          details: {
            resolution: replyContent,
            detectedAt: new Date(),
          },
        });
      }
    }
  }

  // Section 12: Send reminder emails for old escalations
  console.log('[ATC] Section 12: Checking for escalation reminders...');
  const escalationReminders = await getPendingEscalations();
  const REMINDER_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours

  for (const escalation of escalationReminders) {
    const ageMs = Date.now() - escalation.createdAt.getTime();
    if (ageMs > REMINDER_THRESHOLD && !escalation.reminderSentAt) {
      // Send reminder email
      const workItem = await getWorkItem(escalation.workItemId);
      if (workItem) {
        const { sendEscalationEmail } = await import('./gmail');
        const threadId = await sendEscalationEmail(escalation, workItem, true); // isReminder=true
        if (threadId) {
          await updateEscalation(escalation.id, { reminderSentAt: new Date() });
          await recordATCEvent({
            type: 'escalation_reminder_sent',
            escalationId: escalation.id,
            details: {
              threadId,
              sentAt: new Date(),
            },
          });
        }
      }
    }
  }
```

**Also ensure `Escalation` interface in `lib/escalation.ts` has the new optional fields:**

Find the `Escalation` interface definition. It should look like:

```typescript
export interface Escalation {
  id: string;
  workItemId: string;
  reason: string;
  confidenceScore: number;
  contextSnapshot: any;
  status: 'pending' | 'resolved' | 'expired';
  createdAt: Date;
  resolvedAt?: Date;
  resolution?: string;
  threadId?: string;
}
```

Add `reminderSentAt?` field:

```typescript
export interface Escalation {
  id: string;
  workItemId: string;
  reason: string;
  confidenceScore: number;
  contextSnapshot: any;
  status: 'pending' | 'resolved' | 'expired';
  createdAt: Date;
  resolvedAt?: Date;
  resolution?: string;
  threadId?: string;
  reminderSentAt?: Date;
}
```

## Step 5: Update `package.json` - Add googleapis dependency

Find the `"dependencies"` section in `package.json`. Add the `googleapis` package:

```json
"googleapis": "^135.0.0"
```

Or run the install command already done in Step 0.

## Verification

**Before committing, verify:**

1. **Build succeeds:**
   ```bash
   npm run build
   # or: pnpm build
   ```

2. **No TypeScript errors:**
   ```bash
   npm run type-check
   # or: pnpm type-check
   ```

3. **New module imports work:**
   ```bash
   node -e "require('./lib/gmail.ts')" 2>&1 | head -20
   ```

4. **Graceful degradation mode:**
   - Verify that `getGmailClient()` returns `null` when env vars are missing
   - Test `/api/escalations/test-email` with `dev=true` param and confirm graceful fallback

5. **File structure:**
   ```bash
   ls -la lib/gmail.ts
   ls -la app/api/escalations/test-email/route.ts
   ```

6. **Check for syntax errors in modified files:**
   ```bash
   npm run lint
   # or: pnpm lint
   ```

## Final Step: Commit, push, and open PR

```bash
git add -A
git commit -m "feat: add Gmail integration for escalation emails and reply polling

- New lib/gmail.ts: Gmail API client with send/check/parse helpers
- New test endpoint: POST /api/escalations/test-email for verifying setup
- Modify lib/escalation.ts: wire Gmail send into escalate() function
- Modify lib/atc.ts: add sections 11-12 for reply polling and reminders
- Update package.json: add googleapis dependency
- Graceful degradation when Gmail creds not configured
- Support 24h reminder emails for pending escalations

Fixes escalation notification flow. ATC now detects James' replies and auto-resolves."

git push -u origin feat/gmail-escalation

# Open PR
gh pr create \
  --title "feat: Gmail integration for escalation emails" \
  --body "## Summary

Wires Gmail API into Agent Forge escalation system. Escalation emails are now sent when work items are blocked, and the ATC monitor detects replies to auto-resolve escalations.

## Changes
- **lib/gmail.ts**: Gmail client wrapper with OAuth2 auth
- **app/api/escalations/test-email**: Test endpoint for Gmail setup
- **lib/escalation.ts**: Send email on escalate()
- **lib/atc.ts**: Sections 11-12 for reply polling and reminders
- **package.json**: Add googleapis dependency

## Gmail Behavior
- Escalation emails sent FROM/TO james.stine.heath@gmail.com
- Subject: '[Agent Forge] Escalation: {title} ({reason})'
- Structured HTML body with context snapshot and instructions
- Reminder emails sent at 24h mark
- Graceful degradation: no emails if credentials missing

## Testing
- POST /api/escalations/test-email to send test email
- Requires GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN in Vercel env
- Works with james.stine.heath@gmail.com inbox

Depends on: Handoff 11 (Escalation State Machine)" \
  --head feat/gmail-escalation \
  --base main
```

## Session Abort Protocol

If at any point the build fails or verification fails:

1. **Syntax/import error:** Fix the specific file and re-run build
2. **Missing dependency:** Run `npm install googleapis` and rebuild
3. **TypeScript error:** Check modified files for type mismatches
4. **Test endpoint fails:** Verify env vars are not set (graceful degradation should kick in)
5. **Gmail API error:** Check that OAuth2 credentials are valid and refresh token works

**Do not open PR if build fails.** Fix all errors first, verify clean build, then push and open PR.

If uncertain, abort and return full error logs for review.

---

**End of Handoff 12**
