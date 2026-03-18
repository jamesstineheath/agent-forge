"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { AlertTriangle, Clock, ExternalLink, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Escalation } from "@/lib/escalation";

function formatRelativeTime(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function getActionLabel(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes("repo") && (lower.includes("register") || lower.includes("not found"))) {
    return "Register repo";
  }
  if (lower.includes("budget") || lower.includes("cost")) {
    return "Increase budget";
  }
  if (lower.includes("conflict")) {
    return "Resolve conflict";
  }
  return "Resolve";
}

interface EscalationCardProps {
  escalation: Escalation;
  workItemTitle?: string;
  onResolve: () => void;
  onDismiss: () => void;
}

export function EscalationCard({
  escalation,
  workItemTitle,
  onResolve,
  onDismiss,
}: EscalationCardProps) {
  const [resolving, setResolving] = useState(false);

  const handleResolve = async () => {
    setResolving(true);
    try {
      await fetch(`/api/escalations/${escalation.id}/resolve`, {
        method: "POST",
      });
      onResolve();
    } catch {
      // Silently fail; user can retry
    } finally {
      setResolving(false);
    }
  };

  return (
    <div
      className={cn(
        "group relative rounded-xl overflow-hidden card-elevated",
        "bg-status-blocked/[0.04] ring-1 ring-status-blocked/15"
      )}
    >
      {/* Severity accent bar */}
      <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-status-blocked" />

      <div className="flex items-start justify-between gap-4 pl-5 pr-4 py-3.5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-status-blocked shrink-0" />
            <span className="text-[13px] font-semibold text-foreground truncate">
              {workItemTitle ?? escalation.workItemId}
            </span>
          </div>
          <p className="text-[12px] leading-relaxed text-muted-foreground line-clamp-2">
            {escalation.reason}
          </p>
          <div className="flex items-center gap-3 pt-0.5">
            {escalation.projectId && (
              <span className="inline-flex items-center rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground ring-1 ring-border">
                {escalation.projectId}
              </span>
            )}
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
              <Clock className="h-3 w-3" />
              {formatRelativeTime(escalation.createdAt)}
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-status-blocked">
              <Zap className="h-3 w-3" />
              Urgent
            </span>
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleResolve}
            disabled={resolving}
            className="h-8 gap-1.5 text-[11px] font-semibold"
          >
            {resolving ? "..." : getActionLabel(escalation.reason)}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            className="h-8 text-[11px] font-semibold text-muted-foreground"
          >
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}
