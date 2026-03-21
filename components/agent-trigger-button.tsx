"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

interface TriggerResult {
  success: boolean;
  duration: number;
  status: number;
  body?: string;
}

interface AgentTriggerButtonProps {
  agentKey: string;
  agentName: string;
}

export function AgentTriggerButton({
  agentKey,
  agentName,
}: AgentTriggerButtonProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TriggerResult | null>(null);
  const [lastTriggered, setLastTriggered] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleTrigger = async () => {
    setLoading(true);
    setResult(null);
    setError(null);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10 * 60 * 1000);

    try {
      const res = await fetch("/api/agents/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: agentKey }),
        signal: controller.signal,
      });

      const data: TriggerResult = await res.json();
      setResult(data);
      if (data.success) {
        setLastTriggered(new Date());
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setError("Timed out after 10 minutes");
      } else {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Button
          onClick={handleTrigger}
          disabled={loading}
          variant="outline"
          size="xs"
          title={`Manually trigger ${agentName}`}
        >
          {loading ? (
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Running...
            </span>
          ) : (
            "Run Now"
          )}
        </Button>

        {result && (
          <span
            className={`text-[11px] font-medium ${result.success ? "text-status-merged" : "text-status-blocked"}`}
          >
            {result.success
              ? `Done in ${result.duration}s`
              : `Failed (HTTP ${result.status}, ${result.duration}s)`}
          </span>
        )}

        {error && (
          <span className="text-[11px] font-medium text-status-blocked">
            {error}
          </span>
        )}
      </div>

      {lastTriggered && (
        <p className="text-[10px] text-muted-foreground/50">
          Last run: {lastTriggered.toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}
