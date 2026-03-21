"use client";

import { useState, useCallback } from "react";
import { Power, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useKillSwitch } from "@/lib/hooks";

export function SettingsKillSwitch() {
  const { data: killSwitch, isLoading, error, mutate } = useKillSwitch();
  const [toggling, setToggling] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(false);

  const isKilled = killSwitch?.enabled ?? false;

  const handleToggle = useCallback(() => {
    setPin("");
    setPinError(false);
    setShowConfirm(true);
  }, []);

  const confirmToggle = useCallback(async () => {
    setToggling(true);
    setPinError(false);
    try {
      const res = await fetch("/api/pipeline/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !isKilled, pin }),
      });
      if (!res.ok) {
        if (res.status === 403) {
          setPinError(true);
          setToggling(false);
          return;
        }
        const data = await res.json();
        throw new Error(data.error || "Request failed");
      }
      setShowConfirm(false);
      setPin("");
      await mutate();
    } finally {
      setToggling(false);
    }
  }, [isKilled, pin, mutate]);

  if (isLoading) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-6">
        <h3 className="text-sm font-display font-bold text-foreground mb-1">Pipeline Kill Switch</h3>
        <p className="text-xs text-muted-foreground mb-4">
          When enabled, no new work items will be dispatched. In-flight executions continue.
        </p>
        <div className="h-8 bg-muted rounded animate-pulse w-40" />
      </div>
    );
  }

  if (error || !killSwitch) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-6">
        <h3 className="text-sm font-display font-bold text-foreground mb-1">Pipeline Kill Switch</h3>
        <p className="text-xs text-destructive">Failed to load kill switch state</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl card-elevated bg-surface-1 p-6 space-y-4">
      <div>
        <h3 className="text-sm font-display font-bold text-foreground mb-1">Pipeline Kill Switch</h3>
        <p className="text-xs text-muted-foreground">
          When enabled, no new work items will be dispatched. In-flight executions continue.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold",
            isKilled
              ? "bg-status-blocked/15 text-status-blocked"
              : "bg-emerald-500/15 text-emerald-500"
          )}
        >
          <Power className="h-3 w-3" />
          {isKilled ? "HALTED" : "Active"}
        </span>
        {isKilled && killSwitch.toggledAt && (
          <span className="text-xs text-muted-foreground">
            Since {new Date(killSwitch.toggledAt).toLocaleString()}
          </span>
        )}
      </div>

      {!showConfirm ? (
        <button
          onClick={handleToggle}
          disabled={toggling}
          className={cn(
            "text-sm px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50",
            isKilled
              ? "bg-emerald-600 hover:bg-emerald-500 text-white"
              : "bg-status-blocked hover:bg-status-blocked/90 text-white"
          )}
        >
          {isKilled ? "Start Pipeline" : "Stop Pipeline"}
        </button>
      ) : (
        <div className="space-y-3 max-w-sm">
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800">
            {isKilled
              ? "Resume all agents? Queued work items will begin processing."
              : "Stop all agents? Active executions will not be interrupted."}
          </p>
          <div>
            <label className="block text-[11px] font-medium text-muted-foreground mb-1.5">
              Enter PIN to confirm
            </label>
            <input
              type="password"
              value={pin}
              onChange={(e) => { setPin(e.target.value); setPinError(false); }}
              onKeyDown={(e) => { if (e.key === "Enter" && pin) confirmToggle(); }}
              placeholder="PIN"
              autoFocus
              className={cn(
                "w-full rounded-lg bg-surface-2 px-3 py-2 text-[13px] font-mono text-foreground ring-1 outline-none transition-colors placeholder:text-muted-foreground/40",
                pinError
                  ? "ring-status-blocked focus:ring-status-blocked"
                  : "ring-border focus:ring-primary"
              )}
            />
            {pinError && (
              <p className="text-[11px] text-status-blocked mt-1">Incorrect PIN</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={confirmToggle}
              disabled={!pin || toggling}
              className={cn(
                "text-sm px-4 py-2 rounded-lg font-semibold text-white transition-colors disabled:opacity-50",
                isKilled
                  ? "bg-emerald-600 hover:bg-emerald-500"
                  : "bg-status-blocked hover:bg-status-blocked/90"
              )}
            >
              {toggling ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirm"}
            </button>
            <button
              onClick={() => { setShowConfirm(false); setPin(""); setPinError(false); }}
              disabled={toggling}
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
