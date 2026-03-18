"use client";

import { useWebhookEvents } from "@/lib/hooks";
import { Radio } from "lucide-react";

const TYPE_LABELS: Record<string, string> = {
  "github.pr.opened": "PR Opened",
  "github.pr.merged": "PR Merged",
  "github.pr.closed": "PR Closed",
  "github.ci.passed": "CI Passed",
  "github.ci.failed": "CI Failed",
  "github.workflow.completed": "Workflow Done",
  "github.push": "Push",
};

const TYPE_COLORS: Record<string, string> = {
  "github.pr.opened": "text-blue-400",
  "github.pr.merged": "text-purple-400",
  "github.pr.closed": "text-red-400",
  "github.ci.passed": "text-green-400",
  "github.ci.failed": "text-red-400",
  "github.workflow.completed": "text-cyan-400",
  "github.push": "text-yellow-400",
};

function formatRelativeTime(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function WebhookEventFeed() {
  const { data: events, isLoading } = useWebhookEvents(20);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5">
        <div className="relative flex h-6 w-6 items-center justify-center rounded-lg bg-primary/15">
          <Radio className="h-3.5 w-3.5 text-primary" />
        </div>
        <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
          Recent Webhook Events
        </h2>
      </div>
      <div className="rounded-xl card-elevated bg-surface-1 p-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading events...</p>
        ) : !events || events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No webhook events yet. Configure a GitHub webhook to start receiving events.
          </p>
        ) : (
          <div className="space-y-1">
            {events.map((event) => (
              <div
                key={event.id}
                className="flex items-center gap-2.5 text-sm py-1.5 min-w-0"
              >
                <span
                  className={`text-[10px] font-mono font-semibold shrink-0 w-24 ${
                    TYPE_COLORS[event.type] ?? "text-muted-foreground"
                  }`}
                >
                  {TYPE_LABELS[event.type] ?? event.type}
                </span>
                <span className="truncate text-foreground">
                  {event.payload.summary ?? event.type}
                </span>
                <span className="text-[10px] text-muted-foreground/60 ml-auto shrink-0 font-mono">
                  {event.repo.split("/").pop()} &middot;{" "}
                  {formatRelativeTime(event.timestamp)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
