import { loadJson, saveJson } from "./storage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheMetrics {
  endpoint: string;
  timestamp: string; // ISO 8601
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

// Shape of the Anthropic usage object as returned by the AI SDK.
// The cache fields may be on `usage` directly or nested under
// experimental_providerMetadata.anthropic — handle both.
export interface AnthropicResponseLike {
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    // Direct fields (some SDK versions surface these)
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  // AI SDK v3 surfaces provider-specific fields here
  experimental_providerMetadata?: {
    anthropic?: {
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    };
  };
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Extract cache metrics from an Anthropic API response.
 * Handles both direct usage fields and AI SDK provider metadata.
 */
export function extractCacheMetrics(
  response: AnthropicResponseLike,
  endpoint: string
): CacheMetrics {
  const usage = response.usage ?? {};
  const providerMeta =
    response.experimental_providerMetadata?.anthropic ?? {};

  // Cache creation tokens — try provider metadata first, then direct field
  const cacheCreationInputTokens =
    providerMeta.cacheCreationInputTokens ??
    usage.cache_creation_input_tokens ??
    0;

  // Cache read tokens
  const cacheReadInputTokens =
    providerMeta.cacheReadInputTokens ??
    usage.cache_read_input_tokens ??
    0;

  // Standard token counts — AI SDK uses camelCase aliases
  const inputTokens =
    usage.input_tokens ?? usage.promptTokens ?? 0;
  const outputTokens =
    usage.output_tokens ?? usage.completionTokens ?? 0;

  return {
    endpoint,
    timestamp: new Date().toISOString(),
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
  };
}

/**
 * Calculate cost savings from cache usage.
 *
 * Pricing ratios relative to base input token price:
 *   - Regular input tokens:       1.0x
 *   - Cache creation tokens:      1.25x  (writing to cache costs more)
 *   - Cache read tokens:          0.1x   (reading from cache is 10x cheaper)
 *
 * savingsPercent = how much cheaper the actual bill was vs if all tokens
 * were charged at base price.
 */
export function calculateSavings(metrics: CacheMetrics): {
  savingsPercent: number;
  cachedTokens: number;
  uncachedTokens: number;
} {
  const {
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
  } = metrics;

  const cachedTokens = cacheReadInputTokens;
  const uncachedTokens = inputTokens + cacheCreationInputTokens;

  // Cost if all input tokens charged at base price (1.0x)
  const totalInputTokens =
    inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  const hypotheticalCost = totalInputTokens; // in units of "1 token at base price"

  // Actual cost in the same units
  const actualCost =
    inputTokens * 1.0 +
    cacheCreationInputTokens * 1.25 +
    cacheReadInputTokens * 0.1;

  const savings = hypotheticalCost - actualCost;
  const savingsPercent =
    hypotheticalCost > 0
      ? Math.round((savings / hypotheticalCost) * 10000) / 100
      : 0;

  return { savingsPercent, cachedTokens, uncachedTokens };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function getDailyStorageKey(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `cache-metrics/${today}`;
}

/**
 * Append a CacheMetrics record to today's daily log.
 * Reads the existing array (if any), pushes the new entry, writes back.
 * Errors are caught and logged — never throws.
 */
export async function logCacheMetrics(metrics: CacheMetrics): Promise<void> {
  try {
    const key = getDailyStorageKey();
    const entries = (await loadJson<CacheMetrics[]>(key)) ?? [];
    entries.push(metrics);
    await saveJson(key, entries);
  } catch (err) {
    console.error("[cache-metrics] Failed to log metrics:", err);
    // Swallow error — observability failures must not crash callers
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Read today's cache metrics and log a human-readable summary.
 * Intended to be called from the ATC monitoring cycle.
 * Never throws.
 */
export async function summarizeDailyCacheMetrics(): Promise<void> {
  const key = getDailyStorageKey();
  const today = new Date().toISOString().slice(0, 10);

  try {
    const entries = (await loadJson<CacheMetrics[]>(key)) ?? [];

    if (entries.length === 0) {
      console.log(`[ATC cache-metrics] No cache metrics recorded for ${today}`);
      return;
    }

    // Aggregate
    let totalInput = 0;
    let totalCacheCreation = 0;
    let totalCacheRead = 0;
    let totalOutput = 0;

    for (const e of entries) {
      totalInput += e.inputTokens;
      totalCacheCreation += e.cacheCreationInputTokens;
      totalCacheRead += e.cacheReadInputTokens;
      totalOutput += e.outputTokens;
    }

    const totalAllInput = totalInput + totalCacheCreation + totalCacheRead;
    const hitRate =
      totalAllInput > 0
        ? Math.round((totalCacheRead / totalAllInput) * 10000) / 100
        : 0;

    // Aggregate savings
    const aggregateMetrics: CacheMetrics = {
      endpoint: "aggregate",
      timestamp: new Date().toISOString(),
      inputTokens: totalInput,
      cacheCreationInputTokens: totalCacheCreation,
      cacheReadInputTokens: totalCacheRead,
      outputTokens: totalOutput,
    };
    const { savingsPercent } = calculateSavings(aggregateMetrics);

    // Endpoint breakdown
    const byEndpoint: Record<string, number> = {};
    for (const e of entries) {
      byEndpoint[e.endpoint] = (byEndpoint[e.endpoint] ?? 0) + 1;
    }

    console.log(
      `[ATC cache-metrics] Daily summary (${today}) — ` +
        `${entries.length} calls | ` +
        `cache hit rate: ${hitRate}% | ` +
        `cached tokens: ${totalCacheRead.toLocaleString()} | ` +
        `estimated savings: ${savingsPercent}% vs full price | ` +
        `endpoints: ${Object.entries(byEndpoint)
          .map(([ep, n]) => `${ep}(${n})`)
          .join(", ")}`
    );
  } catch (err) {
    console.error("[ATC cache-metrics] Failed to summarize metrics:", err);
  }
}
