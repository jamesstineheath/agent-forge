/**
 * Vercel Spend Monitor
 *
 * Queries the Vercel billing API to track spend against budget thresholds.
 * Used by monitoring workflows to detect and alert on cost overruns.
 *
 * Required env vars:
 *   VERCEL_API_TOKEN - Vercel API Bearer token
 *   VERCEL_TEAM_ID   - Vercel team ID (e.g. "team_xxx")
 */

import { loadJson, saveJson } from "./storage";

export type VercelSpendStatus = {
  currentSpend: number;
  budget: number;
  percentUsed: number;
  alertsSent: string[];
  /** True when the spend check was skipped (e.g. API 404). */
  skipped?: boolean;
  /** Human-readable reason the check was skipped. */
  skipReason?: string;
};

const BLOB_KEY = "vercel-spend-status";
const THRESHOLDS = [50, 75, 100];
const VERCEL_API_BASE = "https://api.vercel.com";

/**
 * Loads the previously persisted spend status from Blob.
 * Returns null if not yet persisted.
 */
async function loadPersistedStatus(): Promise<VercelSpendStatus | null> {
  try {
    return await loadJson<VercelSpendStatus>(BLOB_KEY);
  } catch {
    return null;
  }
}

/**
 * Queries the Vercel billing API and returns current spend status.
 * Merges alertsSent from previously persisted status.
 */
export async function getSpendStatus(): Promise<VercelSpendStatus> {
  const token = process.env.VERCEL_API_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;

  if (!token || !teamId) {
    const missing = [!token && "VERCEL_API_TOKEN", !teamId && "VERCEL_TEAM_ID"].filter(Boolean).join(", ");
    console.warn(`[vercel-spend-monitor] ${missing} not set, skipping spend check`);
    const persisted = await loadPersistedStatus();
    return {
      currentSpend: 0,
      budget: 0,
      percentUsed: 0,
      alertsSent: persisted?.alertsSent ?? [],
    };
  }

  const url = `${VERCEL_API_BASE}/v2/teams/${teamId}/billing`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    throw new Error(
      `Failed to reach Vercel billing API: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (response.status === 404) {
    console.warn(
      `[vercel-spend-monitor] Vercel billing API returned 404 for ${url} — endpoint may not exist for this plan. Skipping spend check.`
    );
    const persisted = await loadPersistedStatus();
    return {
      currentSpend: 0,
      budget: 0,
      percentUsed: 0,
      alertsSent: persisted?.alertsSent ?? [],
      skipped: true,
      skipReason: "Vercel billing API returned 404, endpoint may not exist for this plan",
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(
      `Vercel billing API returned ${response.status} ${response.statusText}: ${body}`
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (err) {
    throw new Error(
      `Failed to parse Vercel billing API response as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const { currentSpend, budget } = parseSpendFromResponse(data);
  const percentUsed = budget > 0 ? (currentSpend / budget) * 100 : 0;

  const persisted = await loadPersistedStatus();
  const alertsSent = persisted?.alertsSent ?? [];

  return {
    currentSpend,
    budget,
    percentUsed,
    alertsSent,
  };
}

/**
 * Extracts spend numbers from the Vercel billing API response.
 * Tries multiple known field paths defensively.
 */
function parseSpendFromResponse(data: unknown): {
  currentSpend: number;
  budget: number;
} {
  if (typeof data !== "object" || data === null) {
    console.warn("[vercel-spend-monitor] Unexpected billing response shape:", data);
    return { currentSpend: 0, budget: 0 };
  }

  const d = data as Record<string, unknown>;

  let currentSpend = 0;
  let budget = 0;

  if (typeof d.currentUsage === "number") currentSpend = d.currentUsage;
  if (typeof d.usage === "number") currentSpend = d.usage;

  const billing = d.billing as Record<string, unknown> | undefined;
  if (billing) {
    if (typeof billing.currentBillingCycleUsage === "number") {
      currentSpend = billing.currentBillingCycleUsage;
    }
    if (typeof billing.balance === "number") currentSpend = billing.balance;
    if (typeof billing.budget === "number") {
      budget = billing.budget as number;
    }
  }

  if (typeof d.billingCycleBudget === "number") budget = d.billingCycleBudget;

  if (currentSpend === 0 && budget === 0) {
    console.warn(
      "[vercel-spend-monitor] Could not extract spend/budget from response. " +
      "API shape may have changed. Raw response keys:",
      Object.keys(d)
    );
  }

  return { currentSpend, budget };
}

/**
 * Returns threshold numbers that have been crossed but not yet alerted.
 * Thresholds: [50, 75, 100] (percent of budget used).
 */
export function checkSpendThresholds(status: VercelSpendStatus): number[] {
  return THRESHOLDS.filter(
    (threshold) =>
      status.percentUsed >= threshold &&
      !status.alertsSent.includes(String(threshold))
  );
}

/**
 * Persists the current spend status to Vercel Blob.
 * Updates alertsSent so future runs know which alerts have been sent.
 */
export async function persistSpendStatus(status: VercelSpendStatus): Promise<void> {
  try {
    await saveJson(BLOB_KEY, status);
  } catch (err) {
    throw new Error(
      `Failed to persist spend status to Blob at '${BLOB_KEY}': ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
  }
}
