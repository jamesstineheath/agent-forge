import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { resolveEscalation } from "@/lib/escalation";
import { updateSlackMessage } from "@/lib/slack";
import type { KnownBlock } from "@slack/web-api";

/**
 * Slack interactivity endpoint.
 * Receives button clicks from Slack messages and routes them to handlers.
 * Must respond within 3 seconds.
 */
export async function POST(req: NextRequest) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    return NextResponse.json({ error: "SLACK_SIGNING_SECRET not configured" }, { status: 500 });
  }

  // Read raw body for signature verification
  const rawBody = await req.text();

  // Verify Slack signature
  const timestamp = req.headers.get("x-slack-request-timestamp") || "";
  const slackSignature = req.headers.get("x-slack-signature") || "";

  // Reject requests older than 5 minutes (replay attack protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    return NextResponse.json({ error: "Request too old" }, { status: 403 });
  }

  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const mySignature = `v0=${crypto
    .createHmac("sha256", signingSecret)
    .update(sigBasestring)
    .digest("hex")}`;

  if (!crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(slackSignature))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  // Parse the payload (Slack sends form-encoded with a `payload` JSON field)
  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get("payload");
  if (!payloadStr) {
    return NextResponse.json({ error: "No payload" }, { status: 400 });
  }

  const payload = JSON.parse(payloadStr) as {
    type: string;
    user: { id: string; username: string; name: string };
    actions: Array<{
      action_id: string;
      value: string;
      type: string;
    }>;
    message: {
      ts: string;
      blocks: Record<string, unknown>[];
    };
    channel: { id: string };
  };

  if (payload.type !== "block_actions") {
    return NextResponse.json({ ok: true });
  }

  const action = payload.actions?.[0];
  if (!action) {
    return NextResponse.json({ ok: true });
  }

  const { action_id } = action;
  const userName = payload.user?.name || payload.user?.username || "Unknown";

  // Route based on action_id prefix
  if (action_id.startsWith("escalation_")) {
    const [actionType, escalationId] = parseActionId(action_id);
    if (!escalationId) {
      return NextResponse.json({ ok: true });
    }

    let resolution: string;
    let emoji: string;
    switch (actionType) {
      case "escalation_approve":
        resolution = `Approved via Slack by ${userName}`;
        emoji = ":white_check_mark:";
        break;
      case "escalation_skip":
        resolution = `Skipped/deferred via Slack by ${userName}`;
        emoji = ":fast_forward:";
        break;
      case "escalation_cancel":
        resolution = `Cancelled via Slack by ${userName}`;
        emoji = ":x:";
        break;
      default:
        return NextResponse.json({ ok: true });
    }

    // Resolve the escalation
    const resolved = await resolveEscalation(escalationId, resolution);
    const statusText = resolved
      ? `${emoji} *${resolution}* at ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}`
      : `:warning: Failed to resolve escalation \`${escalationId}\``;

    // Update the original message: replace action buttons with resolution status
    const originalBlocks = payload.message?.blocks || [];
    const updatedBlocks = originalBlocks
      .filter((b: Record<string, unknown>) => b.type !== "actions")
      .concat({
        type: "section",
        text: { type: "mrkdwn", text: statusText },
      });

    await updateSlackMessage(
      payload.message.ts,
      updatedBlocks as unknown as KnownBlock[],
      statusText
    );

    return NextResponse.json({ ok: true });
  }

  // FLAG_FOR_HUMAN view button is just a link — no server action needed
  if (action_id.startsWith("flag_view:")) {
    return NextResponse.json({ ok: true });
  }

  console.log(`[slack/interactions] Unhandled action: ${action_id}`);
  return NextResponse.json({ ok: true });
}

function parseActionId(actionId: string): [string, string | null] {
  const lastColon = actionId.lastIndexOf(":");
  if (lastColon === -1) return [actionId, null];
  return [actionId.substring(0, lastColon), actionId.substring(lastColon + 1)];
}
