import { NextRequest, NextResponse } from "next/server";
import { appendEvents } from "@/lib/event-bus";
import type { WebhookEvent, GitHubEventType, WebhookEventPayload } from "@/lib/event-bus-types";

/**
 * Verify GitHub webhook signature using HMAC-SHA256.
 */
async function verifySignature(
  payload: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature || !signature.startsWith("sha256=")) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const computed = "sha256=" + Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (computed.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

interface GitHubPayload {
  action?: string;
  pull_request?: {
    number: number;
    merged?: boolean;
    head?: { ref: string; sha: string };
  };
  repository?: { full_name: string };
  ref?: string;
  after?: string;
  workflow_run?: {
    name: string;
    conclusion: string | null;
    head_branch: string;
    head_sha: string;
  };
  check_suite?: {
    conclusion: string | null;
    head_branch: string;
    head_sha: string;
  };
}

/**
 * Map a GitHub webhook event to our internal event type(s).
 */
function mapToWebhookEvents(
  eventType: string,
  body: GitHubPayload
): WebhookEvent[] {
  const repo = body.repository?.full_name ?? "unknown";
  const timestamp = new Date().toISOString();

  const events: WebhookEvent[] = [];

  switch (eventType) {
    case "pull_request": {
      const pr = body.pull_request;
      if (!pr) break;

      let type: GitHubEventType | null = null;
      if (body.action === "opened" || body.action === "reopened") {
        type = "github.pr.opened";
      } else if (body.action === "closed" && pr.merged) {
        type = "github.pr.merged";
      } else if (body.action === "closed" && !pr.merged) {
        type = "github.pr.closed";
      }

      if (type) {
        const payload: WebhookEventPayload = {
          prNumber: pr.number,
          branch: pr.head?.ref,
          commitSha: pr.head?.sha,
          action: body.action,
          summary: `PR #${pr.number} ${body.action}${pr.merged ? " (merged)" : ""}`,
        };
        events.push({ id: generateEventId(), type, timestamp, repo, payload });
      }
      break;
    }

    case "workflow_run": {
      const wf = body.workflow_run;
      if (!wf || body.action !== "completed") break;

      const type: GitHubEventType =
        wf.conclusion === "success" ? "github.ci.passed" : "github.ci.failed";

      const payload: WebhookEventPayload = {
        branch: wf.head_branch,
        commitSha: wf.head_sha,
        workflowName: wf.name,
        conclusion: wf.conclusion ?? undefined,
        action: "completed",
        summary: `${wf.name}: ${wf.conclusion}`,
      };
      events.push({ id: generateEventId(), type, timestamp, repo, payload });

      // Also emit a generic workflow.completed event
      events.push({
        id: generateEventId(),
        type: "github.workflow.completed",
        timestamp,
        repo,
        payload,
      });
      break;
    }

    case "check_suite": {
      const cs = body.check_suite;
      if (!cs || body.action !== "completed") break;

      const type: GitHubEventType =
        cs.conclusion === "success" ? "github.ci.passed" : "github.ci.failed";

      const payload: WebhookEventPayload = {
        branch: cs.head_branch,
        commitSha: cs.head_sha,
        conclusion: cs.conclusion ?? undefined,
        action: "completed",
        summary: `Check suite: ${cs.conclusion}`,
      };
      events.push({ id: generateEventId(), type, timestamp, repo, payload });
      break;
    }

    case "push": {
      const payload: WebhookEventPayload = {
        branch: body.ref?.replace("refs/heads/", ""),
        commitSha: body.after,
        action: "push",
        summary: `Push to ${body.ref?.replace("refs/heads/", "")}`,
      };
      events.push({
        id: generateEventId(),
        type: "github.push",
        timestamp,
        repo,
        payload,
      });
      break;
    }
  }

  return events;
}

export async function POST(req: NextRequest) {
  try {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      console.error("[webhook] GITHUB_WEBHOOK_SECRET not configured");
      return NextResponse.json({ ok: true, events: 0 });
    }

    const rawBody = await req.text();
    const signature = req.headers.get("x-hub-signature-256");

    const valid = await verifySignature(rawBody, signature, secret);
    if (!valid) {
      console.warn("[webhook] Invalid signature");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const eventType = req.headers.get("x-github-event") ?? "unknown";

    // Ping event — used by GitHub to verify webhook is set up
    if (eventType === "ping") {
      return NextResponse.json({ ok: true, event: "ping" });
    }

    let body: GitHubPayload;
    try {
      body = JSON.parse(rawBody) as GitHubPayload;
    } catch {
      console.error("[webhook] Failed to parse body");
      return NextResponse.json({ ok: true, events: 0 });
    }

    const events = mapToWebhookEvents(eventType, body);

    if (events.length > 0) {
      await appendEvents(events);
    }

    return NextResponse.json({ ok: true, events: events.length });
  } catch (err) {
    // Log but never return 500 — GitHub retries cause duplicates
    console.error("[webhook] Error processing webhook:", err);
    return NextResponse.json({ ok: true, events: 0 });
  }
}
