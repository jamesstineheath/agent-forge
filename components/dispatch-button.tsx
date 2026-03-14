"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { WorkItem } from "@/lib/types";

interface DispatchButtonProps {
  workItem: WorkItem;
  onSuccess?: () => void;
}

export function DispatchButton({ workItem, onSuccess }: DispatchButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const isReady = workItem.status === "ready";

  async function handleDispatch() {
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch("/api/orchestrator/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workItemId: workItem.id }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Dispatch failed");
      }

      setSuccess(true);
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dispatch failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Button
        onClick={handleDispatch}
        disabled={!isReady || loading}
        variant="default"
      >
        {loading ? (
          <span className="flex items-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Dispatching...
          </span>
        ) : (
          "Dispatch"
        )}
      </Button>
      {success && (
        <p className="text-sm text-green-600">Dispatched successfully.</p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
