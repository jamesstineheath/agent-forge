# Agent Forge -- Define Prompt Caching Utility and Types

## Metadata
- **Branch:** `feat/prompt-cache-utility`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/prompt-cache.ts

## Context

Agent Forge uses Anthropic Claude via AI SDK (`@ai-sdk/anthropic`, `ai`) for TLM agents and orchestration. This task creates a foundational prompt caching utility module that structures prompts for Anthropic's prefix caching feature.

Anthropic's prompt caching works by placing static, reusable content (system prompts, tool definitions, coding standards) at the beginning of a prompt and marking it with `cache_control: { type: 'ephemeral' }`. Subsequent requests with the same prefix hit the cache and cost only 10% of the base token price for reads (writes cost 125%). Minimum cacheable block sizes are 1024 tokens for Claude Sonnet and 2048 tokens for Opus.

This module is purely additive — it creates a new file `lib/prompt-cache.ts` and does not modify any existing files. It will be consumed by future work items that integrate caching into the orchestrator and TLM agents.

Existing lib pattern for reference: other `lib/*.ts` files use named exports, TypeScript interfaces/types, and JSDoc comments. See `lib/types.ts` for type patterns and `lib/github.ts` for utility function patterns.

## Requirements

1. Create `lib/prompt-cache.ts` with all exports listed below
2. Export `CacheablePrompt` interface: `{ staticPrefix: string; dynamicSuffix: string }`
3. Export `PromptCacheConfig` type: `{ enabled: boolean; staticSections: string[]; cacheTTL?: number }`
4. Export `buildCachedPrompt(config: PromptCacheConfig, dynamicContent: string): CacheablePrompt` — joins all `staticSections` with `\n\n` into `staticPrefix`, assigns `dynamicContent` to `dynamicSuffix`
5. Export `formatForAnthropicAPI(prompt: CacheablePrompt): { system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> }` — returns an array where the static prefix block has `cache_control: { type: 'ephemeral' }` and the dynamic suffix block (if non-empty) has no `cache_control`
6. Export `estimateCacheSavings(staticTokens: number, requestCount: number): { cachedCost: number; uncachedCost: number; savingsPercent: number }` — uses: base cost per token = 1 unit; uncached = `staticTokens * requestCount`; cached = `staticTokens * 1.25 + staticTokens * (requestCount - 1) * 0.1`; savingsPercent = `((uncachedCost - cachedCost) / uncachedCost) * 100`
7. All functions include JSDoc comments explaining Anthropic caching requirements
8. `npx tsc --noEmit` passes with zero errors

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/prompt-cache-utility
```

### Step 1: Create lib/prompt-cache.ts

Create the file `lib/prompt-cache.ts` with the following content:

```typescript
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
```

### Step 2: Verification

```bash
# Confirm TypeScript compiles cleanly
npx tsc --noEmit

# Confirm the file exists and exports are present
grep -E "^export (interface|type|function)" lib/prompt-cache.ts

# Confirm cache_control appears only on the static block in formatForAnthropicAPI
grep -n "cache_control" lib/prompt-cache.ts
```

Expected grep output for exports:
```
export interface CacheablePrompt {
export type PromptCacheConfig = {
export function buildCachedPrompt(
export function formatForAnthropicAPI(
export function estimateCacheSavings(
```

Expected `cache_control` grep: should appear in JSDoc comments and exactly once in `formatForAnthropicAPI` implementation (on the static block push), plus the return type annotation.

### Step 3: Commit, push, open PR

```bash
git add lib/prompt-cache.ts
git commit -m "feat: add prompt caching utility and types (lib/prompt-cache.ts)"
git push origin feat/prompt-cache-utility
gh pr create \
  --title "feat: define prompt caching utility and types" \
  --body "## Summary

Creates \`lib/prompt-cache.ts\` — foundational prompt caching utility for Anthropic's prefix caching.

## What's included

- \`CacheablePrompt\` interface: \`{ staticPrefix, dynamicSuffix }\`
- \`PromptCacheConfig\` type: \`{ enabled, staticSections, cacheTTL? }\`
- \`buildCachedPrompt(config, dynamicContent)\` — concatenates static sections into prefix
- \`formatForAnthropicAPI(prompt)\` — produces Anthropic API system block array with \`cache_control: { type: 'ephemeral' }\` on the final static block only
- \`estimateCacheSavings(staticTokens, requestCount)\` — cost math: write at 1.25×, reads at 0.10×

## Acceptance criteria met

- [x] All 5 exports present
- [x] \`buildCachedPrompt\` joins sections with \`\\n\\n\`, places dynamic content in suffix
- [x] \`formatForAnthropicAPI\` applies \`cache_control\` to static block only
- [x] \`estimateCacheSavings\` correct math (write premium + read discount)
- [x] \`npx tsc --noEmit\` passes

## Notes

This is a pure additive change — no existing files modified. This module will be consumed by future work items integrating caching into the orchestrator and TLM agents."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/prompt-cache-utility
FILES CHANGED: lib/prompt-cache.ts
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```