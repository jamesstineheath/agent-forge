/**
 * Model Router — wraps Anthropic API calls with routing logic and telemetry.
 *
 * Every routed call emits a structured `model_call` event for observability,
 * cost tracking, and the TLM self-improvement loop.
 *
 * Supports Sonnet→Opus escalation: when a Sonnet-routed call fails and the
 * policy's `floorModel` permits Opus, the call is automatically retried with
 * Opus and a `model_escalation` event is emitted.
 */

import { generateText, type ModelMessage, type SystemModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { emitModelCallEvent, emitModelEscalationEvent } from "./atc/events";
import { loadJson } from "./storage";
import type { TaskType } from "./atc/types";
import type { RoutingPolicyOverride, SignalCombinationKey } from "./model-routing-policy";

// ── Constants ────────────────────────────────────────────────────────────────

const OPUS_MODEL = "claude-opus-4-6";
const OVERRIDES_KEY = 'config/routing-policy-overrides';

// ── Override cache (60s TTL) ─────────────────────────────────────────────────

let _overridesCache: RoutingPolicyOverride[] | null = null;
let _overridesCacheExpiry = 0;

async function loadOverrides(): Promise<RoutingPolicyOverride[]> {
  const now = Date.now();
  if (_overridesCache !== null && now < _overridesCacheExpiry) {
    return _overridesCache;
  }
  try {
    const data = await loadJson<RoutingPolicyOverride[]>(OVERRIDES_KEY);
    _overridesCache = data ?? [];
  } catch {
    _overridesCache = [];
  }
  _overridesCacheExpiry = now + 60_000; // 60s TTL
  return _overridesCache;
}

/**
 * Select the appropriate model based on task signals and routing overrides.
 * Checks feedback-compiler overrides first, then falls back to the provided default.
 */
export async function selectModel(
  defaultModel: string,
  taskType: string,
  complexity: string = 'unknown',
  criteriaBucket: string = 'unknown'
): Promise<string> {
  const overrides = await loadOverrides();
  if (overrides.length > 0) {
    const signalKey = `${taskType}|${complexity}|${criteriaBucket}` as SignalCombinationKey;
    const override = overrides.find((o) => o.signalKey === signalKey);
    if (override) {
      return override.forceModel === 'opus' ? OPUS_MODEL : 'claude-sonnet-4-6';
    }
  }
  return defaultModel;
}

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

// ── Types ────────────────────────────────────────────────────────────────────

export interface RoutedCallOptions {
  model: string;
  taskType: TaskType;
  workItemId?: string;
  system?: string | SystemModelMessage | Array<SystemModelMessage>;
  prompt?: string;
  messages?: Array<ModelMessage>;
  /** Controls the minimum (most capable) model allowed for escalation.
   *  - 'sonnet': Sonnet is the floor, Opus escalation is blocked.
   *  - 'opus': Opus is the only option (no escalation needed).
   *  - undefined / 'haiku': Opus escalation is permitted on Sonnet failure. */
  floorModel?: "haiku" | "sonnet" | "opus";
  /** Maximum number of escalation retries (default 1). Set to 0 to disable. */
  maxEscalationRetries?: number;
}

export interface RoutingDecision {
  model: string;
  wasEscalated?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isSonnetModel(model: string): boolean {
  return model.includes("sonnet");
}

function isOpusModel(model: string): boolean {
  return model.includes("opus");
}

// ── Routed Anthropic call ────────────────────────────────────────────────────

/**
 * Make a routed Anthropic API call with automatic telemetry emission.
 *
 * Wraps the Vercel AI SDK `generateText` and emits a `model_call` event
 * on both success and failure. Emission is fire-and-forget.
 *
 * When a Sonnet call fails and `floorModel` permits Opus escalation,
 * the call is retried with Opus automatically.
 */
export async function routedAnthropicCall(
  options: RoutedCallOptions
) {
  const {
    model, taskType, workItemId, system, prompt, messages,
    floorModel, maxEscalationRetries,
  } = options;

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

    return { ...result, routingDecision: { model, wasEscalated: false } as RoutingDecision };
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

    // --- escalation check ---
    const maxRetries = maxEscalationRetries ?? 1;
    const canEscalate =
      maxRetries > 0 &&
      isSonnetModel(model) &&
      floorModel !== "sonnet";

    if (!canEscalate) {
      throw err;
    }

    // --- Sonnet→Opus escalation ---
    const reason = err instanceof Error ? err.message : String(err);
    emitModelEscalationEvent({
      fromModel: model,
      toModel: OPUS_MODEL,
      reason,
      taskType,
      workItemId,
    }).catch(() => {}); // fire-and-forget

    const escalationStart = Date.now();
    try {
      const baseOptions = {
        model: anthropic(OPUS_MODEL),
        ...(system !== undefined ? { system } : {}),
      };

      const escalatedResult = messages
        ? await generateText({ ...baseOptions, messages })
        : await generateText({ ...baseOptions, prompt: prompt ?? "" });

      // --- escalated success path ---
      const escalatedDurationMs = Date.now() - escalationStart;
      const inputTokens = escalatedResult.usage?.inputTokens ?? 0;
      const outputTokens = escalatedResult.usage?.outputTokens ?? 0;

      emitModelCallEvent({
        model: OPUS_MODEL,
        taskType,
        workItemId,
        inputTokens,
        outputTokens,
        durationMs: escalatedDurationMs,
        success: true,
      }).catch(() => {}); // fire-and-forget

      return {
        ...escalatedResult,
        routingDecision: { model: OPUS_MODEL, wasEscalated: true } as RoutingDecision,
      };
    } catch (opusError) {
      // --- escalated error path ---
      const escalatedDurationMs = Date.now() - escalationStart;

      emitModelCallEvent({
        model: OPUS_MODEL,
        taskType,
        workItemId,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: escalatedDurationMs,
        success: false,
        error: opusError instanceof Error ? opusError.constructor.name : String(opusError),
      }).catch(() => {}); // fire-and-forget

      throw opusError; // no further retry
    }
  }
}
