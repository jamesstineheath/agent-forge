"use client";

import useSWR from "swr";
import { useState } from "react";
import { Loader2 } from "lucide-react";

interface ForceSonnetConfig {
  enabled: boolean;
  activatedAt: string | null;
  activatedBy: string | null;
}

const fetcher = (url: string) =>
  fetch(url).then((res) => {
    if (!res.ok) throw new Error("Request failed");
    return res.json();
  });

export function SettingsForceSonnet() {
  const { data, error, isLoading, mutate } = useSWR<ForceSonnetConfig>(
    "/api/config/force-sonnet",
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
      const res = await fetch("/api/config/force-sonnet", {
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
        <h3 className="text-sm font-display font-bold text-foreground mb-1">Force Sonnet Model</h3>
        <p className="text-xs text-muted-foreground mb-4">
          When enabled, all eligible pipeline steps route to Claude Sonnet regardless of routing policy. Lower cost, lower capability.
        </p>
        <div className="h-8 bg-muted rounded animate-pulse w-40" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-6">
        <h3 className="text-sm font-display font-bold text-foreground mb-1">Force Sonnet Model</h3>
        <p className="text-xs text-destructive">Failed to load config</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl card-elevated bg-surface-1 p-6 space-y-4">
      <div>
        <h3 className="text-sm font-display font-bold text-foreground mb-1">Force Sonnet Model</h3>
        <p className="text-xs text-muted-foreground">
          When enabled, all eligible pipeline steps route to Claude Sonnet regardless of routing policy. Lower cost, lower capability.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <span
          className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
            data.enabled
              ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
              : "bg-status-merged/15 text-status-merged"
          }`}
        >
          {data.enabled ? "ACTIVE \u2014 Sonnet Forced" : "Inactive \u2014 Policy Routing"}
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
              : "bg-blue-500 hover:bg-blue-600 text-white"
          }`}
        >
          {data.enabled ? "Deactivate" : "Force Sonnet"}
        </button>
      ) : (
        <div className="space-y-3 max-w-sm">
          <p className="text-sm text-blue-700 bg-blue-50 border border-blue-200 rounded-lg p-2 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800">
            {pendingEnabled
              ? "Are you sure? All eligible pipeline calls will use Sonnet. Quality may decrease for complex tasks."
              : "Deactivate FORCE SONNET and resume policy-based routing?"}
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              disabled={saving}
              className="text-sm px-4 py-2 rounded-lg font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
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
