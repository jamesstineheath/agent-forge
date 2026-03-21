"use client";

import { useState } from "react";
import { Loader2, Check, AlertCircle } from "lucide-react";
import { useRepos } from "@/lib/hooks";
import type { RepoConfig } from "@/lib/types";

interface RowState {
  value: number;
  saving: boolean;
  feedback: "success" | "error" | null;
}

export function SettingsConcurrency() {
  const { data: repos, isLoading, error, mutate } = useRepos();
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});

  const getRowState = (repo: RepoConfig): RowState => {
    return rowStates[repo.id] ?? { value: repo.concurrencyLimit, saving: false, feedback: null };
  };

  const updateRowState = (id: string, patch: Partial<RowState>) => {
    setRowStates((prev) => ({
      ...prev,
      [id]: { ...prev[id]!, ...patch },
    }));
  };

  const handleValueChange = (repo: RepoConfig, newValue: number) => {
    const clamped = Math.max(1, Math.min(10, newValue));
    setRowStates((prev) => ({
      ...prev,
      [repo.id]: { value: clamped, saving: false, feedback: null },
    }));
  };

  const handleSave = async (repo: RepoConfig) => {
    const row = getRowState(repo);
    if (row.value === repo.concurrencyLimit) return;

    updateRowState(repo.id, { saving: true, feedback: null });
    try {
      const res = await fetch(`/api/repos/${repo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concurrencyLimit: row.value }),
      });
      if (!res.ok) throw new Error("Save failed");
      updateRowState(repo.id, { saving: false, feedback: "success" });
      await mutate();
      setTimeout(() => updateRowState(repo.id, { feedback: null }), 2000);
    } catch {
      updateRowState(repo.id, { saving: false, feedback: "error" });
      setTimeout(() => updateRowState(repo.id, { feedback: null }), 3000);
    }
  };

  if (isLoading) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-6">
        <h3 className="text-sm font-display font-bold text-foreground mb-1">Per-Repo Concurrency Limits</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Maximum simultaneous executions per repository.
        </p>
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-10 bg-muted rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-6">
        <h3 className="text-sm font-display font-bold text-foreground mb-1">Per-Repo Concurrency Limits</h3>
        <p className="text-xs text-destructive">Failed to load repositories</p>
      </div>
    );
  }

  if (!repos || repos.length === 0) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-6">
        <h3 className="text-sm font-display font-bold text-foreground mb-1">Per-Repo Concurrency Limits</h3>
        <p className="text-xs text-muted-foreground">
          No repositories registered. Add repos from the Repos page.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl card-elevated bg-surface-1 p-6 space-y-4">
      <div>
        <h3 className="text-sm font-display font-bold text-foreground mb-1">Per-Repo Concurrency Limits</h3>
        <p className="text-xs text-muted-foreground">
          Maximum simultaneous executions per repository (1–10).
        </p>
      </div>

      <div className="divide-y divide-border">
        {repos.map((repo) => {
          const row = getRowState(repo);
          const isDirty = row.value !== repo.concurrencyLimit;

          return (
            <div key={repo.id} className="flex items-center justify-between py-3 gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground truncate">
                  {repo.fullName}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={row.value}
                  onChange={(e) => handleValueChange(repo, parseInt(e.target.value) || 1)}
                  className="w-16 rounded-lg bg-surface-2 px-2 py-1.5 text-sm text-center font-mono text-foreground ring-1 ring-border outline-none focus:ring-primary"
                />
                <button
                  onClick={() => handleSave(repo)}
                  disabled={!isDirty || row.saving}
                  className="text-xs px-3 py-1.5 rounded-lg font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {row.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                </button>
                {row.feedback === "success" && (
                  <Check className="h-4 w-4 text-emerald-500" />
                )}
                {row.feedback === "error" && (
                  <AlertCircle className="h-4 w-4 text-destructive" />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
