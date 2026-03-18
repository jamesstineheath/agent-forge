"use client";

import type { AgentTraceRecord } from "@/lib/hooks";

interface Props {
  trace: AgentTraceRecord;
}

function formatDuration(ms: number | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** Detect CI remediation decision chain */
function isCIRemediationChain(
  decisions: AgentTraceRecord["decisions"]
): boolean {
  const actions = decisions.map((d) => d.action.toLowerCase());
  return (
    actions.some((a) => a.includes("failure") || a.includes("ci")) &&
    actions.some((a) => a.includes("retry") || a.includes("rebase"))
  );
}

export function AgentTraceDetail({ trace }: Props) {
  const hasErrors = trace.errors.length > 0;
  const hasCIChain =
    trace.decisions.length > 1 && isCIRemediationChain(trace.decisions);

  return (
    <div className="space-y-4 text-sm">
      {/* Summary */}
      {trace.summary && (
        <p className="text-xs text-muted-foreground italic">{trace.summary}</p>
      )}

      {/* Phase timeline */}
      {trace.phases.length > 0 && (
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            Phase Timeline
          </h3>
          <ol className="space-y-1">
            {trace.phases.map((phase, i) => (
              <li key={i} className="flex items-center gap-3">
                <span className="w-5 h-5 rounded-full bg-foreground/10 text-foreground text-[10px] flex items-center justify-center font-semibold flex-shrink-0">
                  {i + 1}
                </span>
                <span className="flex-1 font-medium text-foreground">
                  {phase.name}
                </span>
                <span className="tabular-nums text-[11px] text-muted-foreground">
                  {formatDuration(phase.durationMs)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Decisions */}
      {trace.decisions.length > 0 && (
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            Decisions ({trace.decisions.length})
            {hasCIChain && (
              <span className="ml-2 rounded-full bg-status-reviewing/10 px-2 py-0.5 text-[10px] font-normal text-status-reviewing normal-case tracking-normal border border-status-reviewing/30">
                CI Remediation Chain
              </span>
            )}
          </h3>
          {hasCIChain ? (
            <ol className="relative space-y-2">
              {trace.decisions.map((decision, i) => (
                <li key={i} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className="w-6 h-6 rounded-full bg-status-reviewing/10 text-status-reviewing text-[10px] flex items-center justify-center font-bold flex-shrink-0 border border-status-reviewing/30">
                      {i + 1}
                    </span>
                    {i < trace.decisions.length - 1 && (
                      <div className="w-px flex-1 bg-status-reviewing/30 mt-1 min-h-[1rem]" />
                    )}
                  </div>
                  <div className="pb-2">
                    <span className="font-medium text-[11px] text-foreground">
                      {decision.action}
                    </span>
                    <p className="text-muted-foreground mt-0.5">
                      {decision.reason}
                    </p>
                    {decision.workItemId && (
                      <span className="mt-1 inline-block rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground ring-1 ring-border">
                        work-item: {decision.workItemId}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <ul className="space-y-1">
              {trace.decisions.map((decision, i) => (
                <li
                  key={i}
                  className="rounded-md bg-surface-2/50 px-3 py-2 ring-1 ring-border"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-[11px] text-foreground">
                      {decision.action}
                    </span>
                    {decision.workItemId && (
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground flex-shrink-0 ring-1 ring-border">
                        wi:{decision.workItemId}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-muted-foreground">
                    {decision.reason}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Errors */}
      {hasErrors && (
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-status-blocked">
            Errors ({trace.errors.length})
          </h3>
          <div className="space-y-2">
            {trace.errors.map((err, i) => (
              <div
                key={i}
                className="rounded-md border border-status-blocked/30 bg-status-blocked/10 p-3"
              >
                <p className="font-medium text-status-blocked text-xs">{err}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Empty detail state */}
      {trace.decisions.length === 0 &&
        trace.phases.length === 0 &&
        !hasErrors && (
          <p className="text-[11px] text-muted-foreground/60 italic">
            No detailed trace data recorded for this run.
          </p>
        )}
    </div>
  );
}
