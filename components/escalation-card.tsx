"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
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
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 flex items-start gap-3">
      <AlertTriangle size={16} className="text-amber-400 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium text-zinc-200">
            {workItemTitle ?? escalation.workItemId}
          </span>
          <span className="text-[10px] text-zinc-400">
            {escalation.projectId && <>{escalation.projectId} &middot; </>}
            {formatRelativeTime(escalation.createdAt)}
          </span>
        </div>
        <div className="text-xs text-zinc-400 mb-2">{escalation.reason}</div>
        <div className="flex gap-2">
          <button
            onClick={handleResolve}
            disabled={resolving}
            className="text-xs px-2.5 py-1 rounded-md transition-colors bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
          >
            {resolving ? "..." : getActionLabel(escalation.reason)}
          </button>
          <button
            onClick={onDismiss}
            className="text-xs px-2.5 py-1 rounded-md transition-colors bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
