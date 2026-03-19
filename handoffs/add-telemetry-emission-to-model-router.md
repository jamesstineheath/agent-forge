# Agent Forge -- Add Telemetry Emission to Model Router

## Metadata
- **Branch:** `feat/model-router-telemetry`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/model-router.ts

## Context

Agent Forge has a model router (`lib/model-router.ts`) that wraps Anthropic API calls with routing logic (selecting models based on task signals, complexity, etc.). A recent merged PR added `emitModelCallEvent` and related helpers to `lib/atc/events.ts` and `lib/atc/types.ts`. This task wires those two together so every routed API call emits a structured `model_call` event for observability, cost tracking, and the TLM self-improvement loop.

The event emission must be fire-and-forget (`.catch(() => {})`) so it never blocks or throws into the caller. The existing `routedAnthropicCall` function signature should remain unchanged.

## Requirements

1. `routedAnthropicCall` emits a `model_call` event via `emitModelCallEvent` after every successful API call, including: model, taskType, workItemId, signals, routing rationale string, latency (ms), input token count, output token count, estimated cost (USD), `success: true`.
2. `routedAnthropicCall` emits a `model_call` event with `success: false` and `errorType` (string name of the error) when an API call throws.
3. A new `estimateCost(model: string, inputTokens: number, outputTokens: number): number` helper is added to `lib/model-router.ts` using current Anthropic per-model pricing (see Step 2).
4. Event emission is fire-and-forget — it does not affect the return value or error propagation of `routedAnthropicCall`.
5. `npm run build` passes with no TypeScript errors.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/model-router-telemetry
```

### Step 1: Inspect existing files

Read the current implementations to understand exact function signatures and types before modifying anything:

```bash
cat lib/model-router.ts
cat lib/atc/events.ts
cat lib/atc/types.ts
```

Key things to confirm:
- The exact signature of `emitModelCallEvent` in `lib/atc/events.ts` (parameter names, required vs optional fields).
- The `ModelCallEvent` or similar type in `lib/atc/types.ts` — note which fields are required.
- The current shape of `routedAnthropicCall`: its parameters (look for `signals`, `taskType`, `workItemId`, or equivalent), how it invokes the Anthropic SDK, and where the response object is available.
- Whether the Anthropic response exposes `usage.input_tokens` and `usage.output_tokens`.

### Step 2: Add `estimateCost` helper

Inside `lib/model-router.ts`, add the following helper function (place it near the top of the file, after imports). Use Anthropic's published pricing as of mid-2025 (per-million-token rates, converted to per-token):

```typescript
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
    "claude-3-5-sonnet-20241022": { input: 3.0,  output: 15.0 },
    "claude-3-5-sonnet-20240620": { input: 3.0,  output: 15.0 },
    // Claude 3.5 Haiku
    "claude-3-5-haiku-20241022":  { input: 0.8,  output: 4.0  },
    // Claude 3 Opus
    "claude-3-opus-20240229":     { input: 15.0, output: 75.0 },
    // Claude 3 Sonnet
    "claude-3-sonnet-20240229":   { input: 3.0,  output: 15.0 },
    // Claude 3 Haiku
    "claude-3-haiku-20240307":    { input: 0.25, output: 1.25 },
    // Claude 4 / future models — add as they become available
    "claude-opus-4-5":            { input: 15.0, output: 75.0 },
    "claude-sonnet-4-5":          { input: 3.0,  output: 15.0 },
  };

  // Partial-match fallback: if exact model string not found, try prefix match
  const rates =
    PRICING[model] ??
    Object.entries(PRICING).find(([key]) => model.startsWith(key))?.[1] ??
    { input: 3.0, output: 15.0 }; // sensible default (sonnet-tier)

  const costPerToken = {
    input:  rates.input  / 1_000_000,
    output: rates.output / 1_000_000,
  };

  return inputTokens * costPerToken.input + outputTokens * costPerToken.output;
}
```

### Step 3: Wire telemetry into `routedAnthropicCall`

Wrap the Anthropic API call with latency measurement and emit the event after it resolves or rejects. The pattern should look like the following (adapt to the real function body found in Step 1 — do NOT blindly paste this; merge with existing logic):

```typescript
// At the start of the function (or just before the API call), capture start time:
const callStart = Date.now();

// --- success path ---
// After the Anthropic call returns `response`:
const latencyMs = Date.now() - callStart;
const inputTokens  = response.usage?.input_tokens  ?? 0;
const outputTokens = response.usage?.output_tokens ?? 0;

emitModelCallEvent({
  model,
  taskType,           // use the real variable name from the existing code
  workItemId,         // use the real variable name; may be optional — pass undefined if absent
  signals,            // use the real variable name; may be undefined
  rationale,          // routing rationale string already produced by the router, or construct one
  latencyMs,
  inputTokens,
  outputTokens,
  estimatedCostUsd: estimateCost(model, inputTokens, outputTokens),
  success: true,
}).catch(() => {});   // fire-and-forget; never let telemetry throw

// --- error path ---
// In the catch block, before re-throwing:
const latencyMs = Date.now() - callStart;

emitModelCallEvent({
  model,
  taskType,
  workItemId,
  signals,
  rationale,
  latencyMs,
  inputTokens:  0,
  outputTokens: 0,
  estimatedCostUsd: 0,
  success:   false,
  errorType: err instanceof Error ? err.constructor.name : String(err),
}).catch(() => {});

throw err; // always re-throw so caller gets the error
```

Important implementation notes:
- **Check the actual `emitModelCallEvent` signature** from Step 1 output — field names may differ slightly (e.g., `costUsd` vs `estimatedCostUsd`, `latency` vs `latencyMs`). Use the actual field names.
- If `workItemId` or `signals` are not available in the current function scope, pass `undefined` (check whether the type allows it).
- If a `rationale` string isn't already constructed in the router, build a minimal one: `` `Routed to ${model} for ${taskType}` ``.
- Do NOT change the function's return type or existing parameters.

### Step 4: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues:
- A required field on `emitModelCallEvent`'s parameter type that you haven't passed — check `lib/atc/types.ts` and provide a value.
- `usage` being potentially undefined on the Anthropic response — guard with `?? 0` as shown above.

### Step 5: Build check

```bash
npm run build
```

Confirm zero errors.

### Step 6: Commit, push, open PR

```bash
git add lib/model-router.ts
git commit -m "feat: emit model_call telemetry events from model router

- Add estimateCost() helper with per-model Anthropic pricing table
- Wrap routedAnthropicCall to capture latency and token counts
- Emit model_call event (fire-and-forget) on success and failure
- Error path emits success=false with errorType before re-throwing"

git push origin feat/model-router-telemetry

gh pr create \
  --title "feat: add telemetry emission to model router" \
  --body "## Summary

Wires \`lib/model-router.ts\` to emit \`model_call\` events after every Anthropic API call using the \`emitModelCallEvent\` helper added in a recent PR.

## Changes

- **\`lib/model-router.ts\`**
  - Added \`estimateCost(model, inputTokens, outputTokens)\` helper with Anthropic pricing table and prefix-match fallback
  - Wrapped \`routedAnthropicCall\` to measure latency via \`Date.now()\` delta
  - Emits \`model_call\` event on success with model, taskType, workItemId, signals, rationale, latencyMs, token counts, estimated cost
  - Emits \`model_call\` event on failure with \`success: false\` and \`errorType\` before re-throwing
  - Emission is fire-and-forget (\`.catch(() => {})\`) — never blocks API responses

## Acceptance Criteria

- [x] Success path emits model_call event via emitModelCallEvent
- [x] Failure path emits model_call event with success=false and errorType
- [x] estimateCost returns USD cost from model + token counts
- [x] Emission is fire-and-forget (does not block routedAnthropicCall)
- [x] \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/model-router-telemetry
FILES CHANGED: lib/model-router.ts
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If blocked by ambiguous `emitModelCallEvent` signature, missing types, or repeated build failures after 3 attempts:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-telemetry-emission-to-model-router",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/model-router.ts"]
    }
  }'
```