/**
 * Prompt Caching Utility for Anthropic Claude API
 *
 * Anthropic's prompt caching allows static content (system prompts, tool definitions,
 * coding standards) to be cached and reused across requests, significantly reducing
 * token costs for repeated similar calls.
 *
 * Key requirements:
 * - Minimum cacheable block: 1024 tokens for Claude Sonnet, 2048 tokens for Claude Opus
 * - Cache TTL: 5 minutes (ephemeral) — refreshed on each cache hit
 * - Cache writes cost 125% of base token price
 * - Cache reads cost 10% of base token price
 * - Static content MUST appear at the beginning of the prompt (prefix caching)
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */

/**
 * Represents a prompt split into a static cacheable prefix and a dynamic suffix.
 * The staticPrefix contains content that is reused across requests (system context,
 * tool definitions, coding standards). The dynamicSuffix contains per-request
 * content (user input, current task details).
 */
export interface CacheablePrompt {
  /** Static content that will be cached — placed first in the prompt */
  staticPrefix: string;
  /** Dynamic per-request content — placed after the static prefix */
  dynamicSuffix: string;
}

/**
 * Configuration for building a cached prompt.
 *
 * When `enabled` is false, `buildCachedPrompt` still assembles the prompt
 * correctly but consumers should omit `cache_control` blocks (use
 * `formatForAnthropicAPI` which respects the assembled structure regardless).
 */
export type PromptCacheConfig = {
  /** Whether prompt caching is active for this prompt */
  enabled: boolean;
  /**
   * Ordered list of static content sections to concatenate into the cache prefix.
   * Examples: system prompt text, tool schema JSON, repo coding standards.
   * Combined length should exceed the minimum token threshold for your model:
   *   - Claude Sonnet: 1024 tokens (~750 words)
   *   - Claude Opus:   2048 tokens (~1500 words)
   */
  staticSections: string[];
  /**
   * Optional TTL hint in seconds (informational only — Anthropic controls actual TTL).
   * Anthropic currently uses a 5-minute ephemeral cache regardless of this value.
   */
  cacheTTL?: number;
};

/**
 * Builds a CacheablePrompt by concatenating all static sections into a single
 * prefix and storing the dynamic content as the suffix.
 *
 * Static sections are joined with double newlines (`\n\n`) to ensure clean
 * separation between sections (system prompt, tool definitions, standards, etc.).
 *
 * If `config.enabled` is false the structure is still returned correctly —
 * callers may choose to skip cache_control blocks in that case, but the
 * prompt content itself is always valid.
 *
 * @param config   - Caching configuration including static section content
 * @param dynamicContent - Per-request content (user message, task description, etc.)
 * @returns A CacheablePrompt with staticPrefix and dynamicSuffix populated
 *
 * @example
 * const prompt = buildCachedPrompt(
 *   { enabled: true, staticSections: [SYSTEM_PROMPT, TOOL_DEFINITIONS] },
 *   "Summarize this PR: #42"
 * );
 */
export function buildCachedPrompt(
  config: PromptCacheConfig,
  dynamicContent: string
): CacheablePrompt {
  const staticPrefix = config.staticSections.join('\n\n');
  return {
    staticPrefix,
    dynamicSuffix: dynamicContent,
  };
}

/**
 * Formats a CacheablePrompt into the Anthropic API's `system` block array format,
 * applying `cache_control: { type: 'ephemeral' }` to the final static content block.
 *
 * Anthropic requires the cache_control marker to be placed on the LAST block of
 * content that should be included in the cache boundary. Everything up to and
 * including that block is cached as a single prefix.
 *
 * Structure produced:
 *   1. Static prefix block  → `cache_control: { type: 'ephemeral' }` applied here
 *   2. Dynamic suffix block → no cache_control (dynamic, not cached)
 *
 * If dynamicSuffix is empty, only the static block is returned.
 * If staticPrefix is empty, only the dynamic block is returned (no cache_control).
 *
 * @param prompt - A CacheablePrompt produced by `buildCachedPrompt`
 * @returns Anthropic API-compatible system block array
 *
 * @example
 * const system = formatForAnthropicAPI(prompt);
 * const response = await anthropic.messages.create({ model, max_tokens, system, messages });
 */
export function formatForAnthropicAPI(prompt: CacheablePrompt): {
  system: Array<{
    type: 'text';
    text: string;
    cache_control?: { type: 'ephemeral' };
  }>;
} {
  const blocks: Array<{
    type: 'text';
    text: string;
    cache_control?: { type: 'ephemeral' };
  }> = [];

  if (prompt.staticPrefix) {
    blocks.push({
      type: 'text',
      text: prompt.staticPrefix,
      cache_control: { type: 'ephemeral' },
    });
  }

  if (prompt.dynamicSuffix) {
    blocks.push({
      type: 'text',
      text: prompt.dynamicSuffix,
      // No cache_control — dynamic content is not cached
    });
  }

  return { system: blocks };
}

/**
 * Estimates token cost savings from Anthropic prompt caching.
 *
 * Anthropic's cache pricing model (relative to base cost = 1 unit per token):
 *   - Cache WRITE (first request): 1.25× base cost  (25% premium to populate cache)
 *   - Cache READ  (subsequent):    0.10× base cost  (90% discount on cache hits)
 *   - Uncached (no caching):       1.00× base cost
 *
 * This function assumes the cache is populated on the first request and all
 * subsequent requests are cache hits (ideal scenario).
 *
 * @param staticTokens  - Number of tokens in the static prefix being cached
 * @param requestCount  - Total number of requests (including the first cache-write request)
 * @returns Object with cachedCost, uncachedCost, and savingsPercent
 *
 * @example
 * const savings = estimateCacheSavings(2000, 100);
 * // → { cachedCost: 2700, uncachedCost: 200000, savingsPercent: 98.65 }
 *
 * @throws Does not throw, but returns zeros if requestCount < 1
 */
export function estimateCacheSavings(
  staticTokens: number,
  requestCount: number
): {
  cachedCost: number;
  uncachedCost: number;
  savingsPercent: number;
} {
  if (requestCount < 1) {
    return { cachedCost: 0, uncachedCost: 0, savingsPercent: 0 };
  }

  // Uncached: every request pays full base cost for the static tokens
  const uncachedCost = staticTokens * requestCount;

  // Cached: first request pays write premium (1.25×), remaining pay read discount (0.10×)
  const cacheWriteCost = staticTokens * 1.25;
  const cacheReadCost = staticTokens * (requestCount - 1) * 0.1;
  const cachedCost = cacheWriteCost + cacheReadCost;

  // Savings percentage relative to uncached baseline
  const savingsPercent =
    uncachedCost > 0 ? ((uncachedCost - cachedCost) / uncachedCost) * 100 : 0;

  return {
    cachedCost,
    uncachedCost,
    savingsPercent,
  };
}
