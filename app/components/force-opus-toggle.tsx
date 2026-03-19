"use client";

import useSWR from "swr";
import { useState } from "react";

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

export function ForceOpusToggle() {
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
      <div className="rounded-xl card-elevated bg-surface-1 p-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-2">
          Force Opus
        </h3>
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-2">
          Force Opus
        </h3>
        <p className="text-sm text-destructive">Failed to load config</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl card-elevated bg-surface-1 p-4 space-y-3">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
        Force Opus Kill Switch
      </h3>

      <div className="flex items-center gap-3">
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
            data.enabled
              ? "bg-status-blocked/15 text-status-blocked"
              : "bg-status-merged/15 text-status-merged"
          }`}
        >
          {data.enabled ? "ACTIVE \u2014 Opus Forced" : "Inactive \u2014 Policy Routing"}
        </span>
      </div>

      {data.enabled && data.activatedAt && (
        <p className="text-xs text-muted-foreground">
          Activated {new Date(data.activatedAt).toLocaleString()} by{" "}
          {data.activatedBy ?? "unknown"}
        </p>
      )}

      {!confirming ? (
        <button
          onClick={handleToggleClick}
          className={`text-sm px-3 py-1.5 rounded-lg font-medium transition-colors ${
            data.enabled
              ? "bg-secondary hover:bg-secondary/80 text-secondary-foreground"
              : "bg-orange-500 hover:bg-orange-600 text-white"
          }`}
        >
          {data.enabled ? "Deactivate" : "Force Opus"}
        </button>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800">
            {pendingEnabled
              ? "Are you sure? All pipeline calls will use Opus."
              : "Deactivate FORCE OPUS and resume policy-based routing?"}
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              disabled={saving}
              className="text-sm px-3 py-1.5 rounded-lg font-medium bg-destructive hover:bg-destructive/90 text-destructive-foreground disabled:opacity-50"
            >
              {saving ? "Saving..." : "Confirm"}
            </button>
            <button
              onClick={handleCancel}
              disabled={saving}
              className="text-sm px-3 py-1.5 rounded-lg font-medium bg-secondary hover:bg-secondary/80 text-secondary-foreground disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
