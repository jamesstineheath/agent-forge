import { CostEntry } from './types';
import { loadJson, saveJson } from './storage';

// ─── Pricing ────────────────────────────────────────────────────────────────

const PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'claude-sonnet-4-20250514': { inputPerM: 3, outputPerM: 15 },
  'claude-opus-4-20250514': { inputPerM: 15, outputPerM: 75 },
};

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

export function estimateCostFromTokens(
  inputTokens: number,
  outputTokens: number,
  model?: string
): number {
  const pricing = PRICING[model ?? DEFAULT_MODEL] ?? PRICING[DEFAULT_MODEL];
  return (inputTokens / 1_000_000) * pricing.inputPerM +
         (outputTokens / 1_000_000) * pricing.outputPerM;
}

// ─── Date helpers ───────────────────────────────────────────────────────────

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function storageKey(dateStr: string): string {
  return `costs/${dateStr}`;
}

function dateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cur = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cur <= end) {
    dates.push(toDateString(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// ─── Storage helpers ────────────────────────────────────────────────────────

async function readDailyFile(dateStr: string): Promise<CostEntry[]> {
  const data = await loadJson<CostEntry[]>(storageKey(dateStr));
  return data ?? [];
}

async function writeDailyFile(dateStr: string, entries: CostEntry[]): Promise<void> {
  await saveJson(storageKey(dateStr), entries);
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function recordCost(entry: CostEntry): Promise<void> {
  const dateStr = toDateString(new Date(entry.timestamp));
  const existing = await readDailyFile(dateStr);
  existing.push(entry);
  await writeDailyFile(dateStr, existing);
}

export async function getCostsForWorkItem(workItemId: string): Promise<CostEntry[]> {
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setUTCDate(today.getUTCDate() - 30);
  const dates = dateRange(toDateString(thirtyDaysAgo), toDateString(today));
  const results = await Promise.all(dates.map(readDailyFile));
  return results.flat().filter(e => e.workItemId === workItemId);
}

export async function getCostsForPeriod(
  startDate: string,
  endDate: string
): Promise<CostEntry[]> {
  const dates = dateRange(startDate, endDate);
  const results = await Promise.all(dates.map(readDailyFile));
  return results.flat();
}

export function aggregateCosts(entries: CostEntry[]): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byAgent: Record<string, number>;
  byRepo: Record<string, number>;
} {
  const byAgent: Record<string, number> = {};
  const byRepo: Record<string, number> = {};
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;

  for (const entry of entries) {
    totalInputTokens += entry.inputTokens ?? 0;
    totalOutputTokens += entry.outputTokens ?? 0;
    totalCostUsd += entry.estimatedCostUsd ?? 0;

    if (entry.agentType) {
      byAgent[entry.agentType] = (byAgent[entry.agentType] ?? 0) + (entry.estimatedCostUsd ?? 0);
    }
    if (entry.repo) {
      byRepo[entry.repo] = (byRepo[entry.repo] ?? 0) + (entry.estimatedCostUsd ?? 0);
    }
  }

  return { totalInputTokens, totalOutputTokens, totalCostUsd, byAgent, byRepo };
}
