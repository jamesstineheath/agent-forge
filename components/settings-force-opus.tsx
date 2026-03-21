"use client";

import useSWR from "swr";
import { useState } from "react";
import { Loader2 } from "lucide-react";

interface ForceOpusConfig {
  enabled: boolean;
  activatedAt: string | null;
  activatedBy: string | null;
}

const fetcher = (url: string) =>
  fetch(url).then((res) => {
    if (!res.ok) throw new Error("Request failed");
    return res.json();
  });

export function SettingsForceOpus() {
  const { data, error, isLoading, mutate } = useSWR<ForceOpusConfig>(
    "/api/config/force-opus",
    fetcher,
    { refreshInterval: 30_000 }
  );
  const [confirming, setConfirming] = useState(false);
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  const handleToggleClick = () => {
    if (!data) return;
    setPendingEnabled(!data.enabled);
    setConfirming(true);
  };

  const handleConfirm = async () => {
    if (pendingEnabled === null) return;
    setSaving(true);
    try {
      const res = await fetch("/api/config/force-opus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: pendingEnabled }),
      });
      if (res.ok) {
        const updated = await res.json();
        mutate(updated, false);
      }
    } finally {
      setSaving(false);
      setConfirming(false);
      setPendingEnabled(null);
    }
  };

  const handleCancel = () => {
    setConfirming(false);
    setPendingEnabled(null);
  };

  if (isLoading) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-6">
        <h3 className="text-sm font-display font-bold text-foreground mb-1">Force Opus Model</h3>
        <p className="text-xs text-muted-foreground mb-4">
          When enabled, all agent executions use Claude Opus regardless of per-handoff model selection. Higher quality, higher cost.
        </p>
        <div className="h-8 bg-muted rounded animate-pulse w-40" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-6">
        <h3 className="text-sm font-display font-bold text-foreground mb-1">Force Opus Model</h3>
        <p className="text-xs text-destructive">Failed to load config</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl card-elevated bg-surface-1 p-6 space-y-4">
      <div>
        <h3 className="text-sm font-display font-bold text-foreground mb-1">Force Opus Model</h3>
        <p className="text-xs text-muted-foreground">
          When enabled, all agent executions use Claude Opus regardless of per-handoff model selection. Higher quality, higher cost.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <span
          className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
            data.enabled
              ? "bg-status-blocked/15 text-status-blocked"
              : "bg-status-merged/15 text-status-merged"
          }`}
        >
          {data.enabled ? "ACTIVE — Opus Forced" : "Inactive — Policy Routing"}
        </span>
        {data.enabled && data.activatedAt && (
          <span className="text-xs text-muted-foreground">
            Activated {new Date(data.activatedAt).toLocaleString()} by {data.activatedBy ?? "unknown"}
          </span>
        )}
      </div>

      {!confirming ? (
        <button
          onClick={handleToggleClick}
          className={`text-sm px-4 py-2 rounded-lg font-medium transition-colors ${
            data.enabled
              ? "bg-secondary hover:bg-secondary/80 text-secondary-foreground"
              : "bg-orange-500 hover:bg-orange-600 text-white"
          }`}
        >
          {data.enabled ? "Deactivate" : "Force Opus"}
        </button>
      ) : (
        <div className="space-y-3 max-w-sm">
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800">
            {pendingEnabled
              ? "Are you sure? All pipeline calls will use Opus."
              : "Deactivate FORCE OPUS and resume policy-based routing?"}
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              disabled={saving}
              className="text-sm px-4 py-2 rounded-lg font-semibold bg-destructive hover:bg-destructive/90 text-destructive-foreground disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirm"}
            </button>
            <button
              onClick={handleCancel}
              disabled={saving}
              className="text-sm px-4 py-2 rounded-lg font-medium bg-secondary hover:bg-secondary/80 text-secondary-foreground disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
