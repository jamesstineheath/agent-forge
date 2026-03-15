"use client";

import { useState } from "react";
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
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm">
            {workItemTitle ?? escalation.workItemId}
          </p>
          <p className="text-sm text-gray-700 mt-1">{escalation.reason}</p>
          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
            {escalation.projectId && <span>{escalation.projectId}</span>}
            {escalation.projectId && <span>&middot;</span>}
            <span>{formatRelativeTime(escalation.createdAt)}</span>
            <span>&middot;</span>
            <span>Confidence: {Math.round(escalation.confidenceScore * 100)}%</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            onClick={handleResolve}
            disabled={resolving}
          >
            {resolving ? "..." : getActionLabel(escalation.reason)}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}
