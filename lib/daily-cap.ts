import { loadJson, saveJson } from "./storage";

const CONFIG_KEY = "config/daily-caps";

export interface DailyCapConfig {
  defaults: { limit: number };
  overrides: Record<string, number>;
}

export interface CapCheckResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

interface DailyUsage {
  count: number;
  date: string;
  agent: string;
}

function getUtcDateString(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function usageKey(date: string, agent: string): string {
  return `daily-caps/${date}/${agent}`;
}

export async function getDailyCapConfig(): Promise<DailyCapConfig> {
  const config = await loadJson<DailyCapConfig>(CONFIG_KEY);
  return config ?? { defaults: { limit: 3 }, overrides: {} };
}

export async function checkDailyCap(triggeredBy: string): Promise<CapCheckResult> {
  if (triggeredBy === "james") {
    return { allowed: true, remaining: Infinity, limit: Infinity };
  }

  const config = await getDailyCapConfig();
  const limit = config.overrides[triggeredBy] ?? config.defaults.limit;
  const date = getUtcDateString();

  const usage = await loadJson<DailyUsage>(usageKey(date, triggeredBy));
  const count = usage?.count ?? 0;

  const remaining = Math.max(0, limit - count);
  return {
    allowed: count < limit,
    remaining,
    limit,
  };
}

export async function incrementDailyCount(triggeredBy: string): Promise<void> {
  if (triggeredBy === "james") return;

  const date = getUtcDateString();
  const key = usageKey(date, triggeredBy);

  const usage = await loadJson<DailyUsage>(key);
  const count = usage?.count ?? 0;

  const updated: DailyUsage = { count: count + 1, date, agent: triggeredBy };
  await saveJson(key, updated);
}
