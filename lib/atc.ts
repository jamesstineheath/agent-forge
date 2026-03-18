import { loadJson, saveJson } from "./storage";
import { listWorkItems, getWorkItem } from "./work-items";
import type { ATCState, WorkItem } from "./types";
import { detectDrift, saveDriftSnapshot, formatDriftAlert } from "./drift-detection";
import { sendEmail } from "./gmail";

// --- Re-exports from extracted modules (backward compatibility) ---
export { parseEstimatedFiles, hasFileOverlap, HIGH_CHURN_FILES, makeEvent, withTimeout, recordAgentRun, getAgentLastRun } from "./atc/utils";
export { acquireATCLock, releaseATCLock, acquireLock, releaseLock } from "./atc/lock";
export { getATCState, getATCEvents, getWorkItemEvents, persistEvents } from "./atc/events";
export { CycleTimeoutError } from "./atc/types";
export type { CycleContext, HLOStateEntry } from "./atc/types";
export { runDispatcher } from "./atc/dispatcher";
export { runHealthMonitor } from "./atc/health-monitor";
export { runProjectManager } from "./atc/project-manager";
export { runSupervisor, cleanupStaleBranches } from "./atc/supervisor";

// --- Import extracted modules for the monolith cycle ---
import { acquireATCLock, releaseATCLock } from "./atc/lock";
import { getATCState, persistEvents } from "./atc/events";
import { withTimeout, makeEvent } from "./atc/utils";
import { runDispatcher } from "./atc/dispatcher";
import { runHealthMonitor } from "./atc/health-monitor";
import { runProjectManager } from "./atc/project-manager";
import { runSupervisor } from "./atc/supervisor";
import {
  ATC_STATE_KEY,
  CYCLE_TIMEOUT_MS,
  CycleTimeoutError,
} from "./atc/types";
import type { CycleContext } from "./atc/types";

/**
 * Backward-compatible monolith cycle: calls all four agents sequentially.
 * Used by /api/atc/cron when AGENT_SPLIT_ENABLED is not set.
 */
export async function runATCCycle(): Promise<ATCState> {
  const locked = await acquireATCLock();
  if (!locked) {
    return await getATCState();
  }

  try {
    return await withTimeout(_runATCCycleInner(), CYCLE_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof CycleTimeoutError) {
      console.error(`[atc] Cycle aborted after ${CYCLE_TIMEOUT_MS / 1000}s timeout.`);
      return await getATCState();
    }
    throw err;
  } finally {
    await releaseATCLock();
  }
}

async function _runATCCycleInner(): Promise<ATCState> {
  const now = new Date();
  const ctx: CycleContext = { now, events: [] };

  // Phase 0-1: Dispatch
  await runDispatcher(ctx);

  // Phase 2: Monitoring
  const activeExecutions = await runHealthMonitor(ctx);

  // Phase 3: Project management (§4, §4.5, §13)
  await runProjectManager(ctx);

  // Phase 4: Supervision (§10-16, branch cleanup, agent health)
  await runSupervisor(ctx);

  // §17 — Drift Detection (once per 24h)
  const previousState = await getATCState();
  let lastDriftCheckAt = previousState.lastDriftCheckAt;
  const DRIFT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const lastDriftCheck = lastDriftCheckAt
    ? new Date(lastDriftCheckAt).getTime()
    : 0;
  const driftCheckDue = Date.now() - lastDriftCheck > DRIFT_CHECK_INTERVAL_MS;

  if (driftCheckDue) {
    try {
      ctx.events.push(makeEvent("drift_check", "system", undefined, undefined, "§17 — Drift Detection: running drift check"));
      const allIndexEntries = await listWorkItems();
      const allWorkItems: WorkItem[] = [];
      for (const entry of allIndexEntries) {
        const item = await getWorkItem(entry.id);
        if (item) allWorkItems.push(item);
      }
      const driftSnapshot = detectDrift({
        workItems: allWorkItems,
        baselinePeriodDays: 30,
        currentPeriodDays: 7,
      });
      await saveDriftSnapshot(driftSnapshot);
      lastDriftCheckAt = new Date().toISOString();

      if (driftSnapshot.degraded) {
        const alertBody = formatDriftAlert(driftSnapshot);
        ctx.events.push(makeEvent("drift_check", "system", undefined, undefined, `§17 — Drift Detection: DEGRADED — driftScore=${driftSnapshot.driftScore.toFixed(3)}`));
        try {
          await sendEmail({
            subject: "[Agent Forge] Pipeline Drift Detected",
            body: alertBody,
          });
          ctx.events.push(makeEvent("drift_check", "system", undefined, undefined, "§17 — Drift Detection: alert email sent"));
        } catch (emailErr) {
          console.warn("[ATC §17] Failed to send drift alert email:", emailErr);
          ctx.events.push(makeEvent("drift_check", "system", undefined, undefined, `§17 — Drift Detection: email send failed: ${String(emailErr)}`));
        }
      } else {
        ctx.events.push(makeEvent("drift_check", "system", undefined, undefined, `§17 — Drift Detection: OK — driftScore=${driftSnapshot.driftScore.toFixed(3)}`));
      }
    } catch (driftErr) {
      console.warn("[ATC §17] Drift detection failed:", driftErr);
      ctx.events.push(makeEvent("drift_check", "system", undefined, undefined, `§17 — Drift Detection: ERROR — ${String(driftErr)}`));
    }
  } else {
    ctx.events.push(makeEvent("drift_check", "system", undefined, undefined, "§17 — Drift Detection: skipped (last check within 24h)"));
  }

  // Build and save state
  const queuedEntries = await listWorkItems({ status: "queued" });
  const readyEntries = await listWorkItems({ status: "ready" });
  const state: ATCState = {
    lastRunAt: now.toISOString(),
    activeExecutions,
    queuedItems: queuedEntries.length + readyEntries.length,
    recentEvents: ctx.events.slice(-20),
    lastDriftCheckAt,
  };
  await saveJson(ATC_STATE_KEY, state);

  // Persist events
  await persistEvents(ctx.events);

  return state;
}
