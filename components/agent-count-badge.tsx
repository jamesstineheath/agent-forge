"use client";

import { useAgentCount } from "@/lib/hooks";

interface AgentCountBadgeProps {
  className?: string;
}

export function AgentCountBadge({ className }: AgentCountBadgeProps) {
  const { data, isLoading } = useAgentCount();

  if (isLoading || !data) {
    return (
      <span
        className={`inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600 ${className ?? ""}`}
      >
        &mdash;
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700 ${className ?? ""}`}
      title={`${data.cronAgents} cron agents + ${data.tlmAgents} TLM agents`}
    >
      {data.total} agents
    </span>
  );
}

export function useFeedbackCompilerStatus() {
  const { data } = useAgentCount();
  return {
    lastRun: data?.feedbackCompilerLastRun ?? null,
    isLoading: !data,
  };
}

export function usePAAgentsAvailable() {
  const { data } = useAgentCount();
  return data?.paAgentsAvailable ?? false;
}
