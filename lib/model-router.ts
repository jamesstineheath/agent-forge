/**
 * Model Router — wraps Anthropic API calls with routing logic and telemetry.
 *
 * Every routed call emits a structured `model_call` event for observability,
 * cost tracking, and the TLM self-improvement loop.
 */

import { generateText, type ModelMessage, type SystemModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { emitModelCallEvent } from "./atc/events";
import type { TaskType } from "./atc/types";

// ── Cost estimation ──────────────────────────────────────────────────────────

/**
 * Estimate the USD cost of an Anthropic API call.
 * Prices are per-token (Anthropic publishes per-million-token rates).
 * Update this table when Anthropic changes pricing.
 */
function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  // Rates in USD per 1M tokens
  const PRICING: Record<string, { input: number; output: number }> = {
    // Claude 3.5 Sonnet
    "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0 },
    "claude-3-5-sonnet-20240620": { input: 3.0, output: 15.0 },
    // Claude 3.5 Haiku
    "claude-3-5-haiku-20241022": { input: 0.8, output: 4.0 },
    // Claude 3 Opus
    "claude-3-opus-20240229": { input: 15.0, output: 75.0 },
    // Claude 3 Sonnet
    "claude-3-sonnet-20240229": { input: 3.0, output: 15.0 },
    // Claude 3 Haiku
    "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
    // Claude 4 models
    "claude-opus-4-6": { input: 15.0, output: 75.0 },
    "claude-opus-4-5": { input: 15.0, output: 75.0 },
    "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
    "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  };

  // Partial-match fallback: if exact model string not found, try prefix match
  const rates =
    PRICING[model] ??
    Object.entries(PRICING).find(([key]) => model.startsWith(key))?.[1] ??
    { input: 3.0, output: 15.0 }; // sensible default (sonnet-tier)

  const costPerToken = {
    input: rates.input / 1_000_000,
    output: rates.output / 1_000_000,
  };

  return inputTokens * costPerToken.input + outputTokens * costPerToken.output;
}

// ── Routed Anthropic call ────────────────────────────────────────────────────

export interface RoutedCallOptions {
  model: string;
  taskType: TaskType;
  workItemId?: string;
  system?: string | SystemModelMessage | Array<SystemModelMessage>;
  prompt?: string;
  messages?: Array<ModelMessage>;
}

/**
 * Make a routed Anthropic API call with automatic telemetry emission.
 *
 * Wraps the Vercel AI SDK `generateText` and emits a `model_call` event
 * on both success and failure. Emission is fire-and-forget.
 */
export async function routedAnthropicCall(
  options: RoutedCallOptions
) {
  const { model, taskType, workItemId, system, prompt, messages } = options;

  const callStart = Date.now();

  try {
    const baseOptions = {
      model: anthropic(model),
      ...(system !== undefined ? { system } : {}),
    };

    const result = messages
      ? await generateText({ ...baseOptions, messages })
      : await generateText({ ...baseOptions, prompt: prompt ?? "" });

    // --- success path ---
    const durationMs = Date.now() - callStart;
    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;

    emitModelCallEvent({
      model,
      taskType,
      workItemId,
      inputTokens,
      outputTokens,
      durationMs,
      success: true,
    }).catch(() => {}); // fire-and-forget

    return result;
  } catch (err) {
    // --- error path ---
    const durationMs = Date.now() - callStart;

    emitModelCallEvent({
      model,
      taskType,
      workItemId,
      inputTokens: 0,
      outputTokens: 0,
      durationMs,
      success: false,
      error: err instanceof Error ? err.constructor.name : String(err),
    }).catch(() => {}); // fire-and-forget

    throw err; // always re-throw so caller gets the error
  }
}
