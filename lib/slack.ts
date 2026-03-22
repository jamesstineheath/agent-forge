import { WebClient, type ChatPostMessageResponse, type KnownBlock } from "@slack/web-api";
import type { Escalation } from "./escalation";
import type { WorkItem } from "./types";

// Slack client singleton
let slackClient: WebClient | null = null;
let slackInitialized = false;

function initSlackClient(): WebClient | null {
  if (slackInitialized) return slackClient;
  slackInitialized = true;

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.log("[Slack] SLACK_BOT_TOKEN not configured. Slack notifications disabled.");
    return null;
  }

  slackClient = new WebClient(token);
  console.log("[Slack] Client initialized.");
  return slackClient;
}

export function isSlackConfigured(): boolean {
  return !!process.env.SLACK_BOT_TOKEN;
}

function getChannel(): string {
  return process.env.SLACK_CHANNEL_ID || "";
}

// ─── Core send functions ─────────────────────────────────────────────

export interface SlackResult {
  ts: string;
  channel: string;
}

/**
 * Send a plain text message to the Agent Forge channel.
 */
export async function sendSlackMessage(
  text: string,
  threadTs?: string
): Promise<SlackResult | null> {
  const client = initSlackClient();
  if (!client) return null;

  try {
    const res = await client.chat.postMessage({
      channel: getChannel(),
      text,
      thread_ts: threadTs,
    });
    return extractResult(res);
  } catch (err) {
    console.error("[Slack] Failed to send message:", err);
    return null;
  }
}

/**
 * Send a Block Kit message to the Agent Forge channel.
 */
export async function sendSlackBlocks(
  blocks: KnownBlock[],
  text: string, // fallback text for notifications
  threadTs?: string
): Promise<SlackResult | null> {
  const client = initSlackClient();
  if (!client) return null;

  try {
    const res = await client.chat.postMessage({
      channel: getChannel(),
      blocks,
      text,
      thread_ts: threadTs,
    });
    return extractResult(res);
  } catch (err) {
    console.error("[Slack] Failed to send blocks:", err);
    return null;
  }
}

/**
 * Update an existing Slack message (e.g., to replace buttons with resolution status).
 */
export async function updateSlackMessage(
  ts: string,
  blocks: KnownBlock[],
  text: string
): Promise<boolean> {
  const client = initSlackClient();
  if (!client) return false;

  try {
    await client.chat.update({
      channel: getChannel(),
      ts,
      blocks,
      text,
    });
    return true;
  } catch (err) {
    console.error("[Slack] Failed to update message:", err);
    return false;
  }
}

function extractResult(res: ChatPostMessageResponse): SlackResult | null {
  if (res.ok && res.ts && res.channel) {
    return { ts: res.ts, channel: res.channel };
  }
  return null;
}

// ─── Notification-specific formatters ────────────────────────────────

/**
 * Send an escalation notification with interactive buttons.
 */
export async function sendSlackEscalation(
  escalation: Escalation,
  workItem: WorkItem,
  isReminder = false
): Promise<SlackResult | null> {
  const emoji = isReminder ? ":bell:" : ":rotating_light:";
  const prefix = isReminder ? "Reminder — " : "";
  const fallbackText = `${prefix}Escalation: ${workItem.title} (${escalation.reason})`;

  const contextLines: string[] = [];
  if (escalation.contextSnapshot) {
    const snap = escalation.contextSnapshot;
    if (snap.errorLog) contextLines.push(`Error: ${String(snap.errorLog).substring(0, 200)}`);
    if (snap.ciConclusion) contextLines.push(`CI: ${snap.ciConclusion}`);
    if (snap.prUrl) contextLines.push(`PR: ${snap.prUrl}`);
  }

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} ${prefix}Escalation: ${workItem.title}` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Reason:*\n${escalation.reason}` },
        { type: "mrkdwn", text: `*Confidence:*\n${Math.round(escalation.confidenceScore * 100)}%` },
      ],
    },
  ];

  if (contextLines.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `\`\`\`${contextLines.join("\n")}\`\`\`` },
    });
  }

  // Interactive buttons for resolution
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Approve / Go Ahead" },
        style: "primary",
        action_id: `escalation_approve:${escalation.id}`,
        value: escalation.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Skip / Defer" },
        action_id: `escalation_skip:${escalation.id}`,
        value: escalation.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Cancel" },
        style: "danger",
        action_id: `escalation_cancel:${escalation.id}`,
        value: escalation.id,
      },
    ],
  });

  blocks.push({
    type: "context",
    elements: [
      { type: "mrkdwn", text: `Work item: \`${workItem.id.substring(0, 8)}\` | Created: ${escalation.createdAt}` },
    ],
  });

  return sendSlackBlocks(blocks, fallbackText);
}

/**
 * Send a FLAG_FOR_HUMAN notification with PR details and action buttons.
 */
export async function sendSlackFlagForHuman(payload: {
  repo: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  summary: string;
  riskAssessment?: string;
  options?: string[];
  recommendedPath?: string;
}): Promise<SlackResult | null> {
  const { repo, prNumber, prTitle, prUrl, summary, riskAssessment, options, recommendedPath } = payload;
  const fallbackText = `Pipeline Decision Required: PR #${prNumber} — ${prTitle}`;

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: ":warning: Pipeline Decision Required" },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*<${prUrl}|#${prNumber} — ${prTitle}>*\n*Repo:* ${repo}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*What's at stake:*\n${summary}` },
    },
  ];

  if (riskAssessment) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Risk Assessment:*\n${riskAssessment}` },
    });
  }

  if (options && options.length > 0) {
    const optionsText = options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Options:*\n${optionsText}` },
    });
  }

  if (recommendedPath) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:white_check_mark: *Recommended:* ${recommendedPath}` },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "View PR" },
        url: prUrl,
        action_id: `flag_view:${prNumber}`,
      },
    ],
  });

  return sendSlackBlocks(blocks, fallbackText);
}

/**
 * Send a daily digest summary.
 */
export async function sendSlackDigest(digest: {
  healthSummary: string;
  mergedPRs: { title: string; url: string; number: number }[];
  openPRs: { title: string; url: string; number: number; ciStatus?: string }[];
  workItemStats: { completed: unknown[]; failed: unknown[]; dispatched: unknown[]; stuck: unknown[] };
  escalations: unknown[];
}): Promise<SlackResult | null> {
  const { healthSummary, mergedPRs, openPRs, workItemStats, escalations } = digest;
  const fallbackText = `Agent Forge Daily Digest — ${healthSummary}`;

  const mergedText = mergedPRs.length > 0
    ? mergedPRs.map(pr => `• <${pr.url}|#${pr.number}> ${pr.title}`).join("\n")
    : "_None_";

  const openText = openPRs.length > 0
    ? openPRs.map(pr => `• <${pr.url}|#${pr.number}> ${pr.title} ${pr.ciStatus ? `(${pr.ciStatus})` : ""}`).join("\n")
    : "_None_";

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `:newspaper: Daily Digest — ${healthSummary}` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Completed:* ${workItemStats.completed.length}` },
        { type: "mrkdwn", text: `*Failed:* ${workItemStats.failed.length}` },
        { type: "mrkdwn", text: `*Active:* ${workItemStats.dispatched.length}` },
        { type: "mrkdwn", text: `*Stuck:* ${workItemStats.stuck.length}` },
      ],
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Merged PRs (24h):*\n${mergedText}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Open PRs:*\n${openText}` },
    },
  ];

  if (escalations.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:rotating_light: *${escalations.length} pending escalation(s)*` },
    });
  }

  return sendSlackBlocks(blocks, fallbackText);
}

// ─── Fallback wrapper ────────────────────────────────────────────────

/**
 * Try Slack first, fall back to email if Slack fails or is not configured.
 * Returns which channel was used and the message ID.
 */
export async function sendWithFallback(
  slackFn: () => Promise<SlackResult | null>,
  emailFn: () => Promise<string | null>
): Promise<{ channel: "slack" | "email"; id: string | null }> {
  if (isSlackConfigured()) {
    try {
      const result = await slackFn();
      if (result) return { channel: "slack", id: result.ts };
    } catch (err) {
      console.error("[Slack] Failed, falling back to email:", err);
    }
  }
  const threadId = await emailFn();
  return { channel: "email", id: threadId };
}
