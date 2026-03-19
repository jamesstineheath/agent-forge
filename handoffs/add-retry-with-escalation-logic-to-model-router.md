# Agent Forge -- Add retry-with-escalation logic to model router

## Metadata
- **Branch:** `feat/model-router-sonnet-opus-escalation`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/model-router.ts

## Context

Agent Forge uses a model router (`lib/model-router.ts`) to dispatch Anthropic API calls to the appropriate model (Sonnet or Opus) based on a routing policy. Currently, if a Sonnet-routed call fails, the error propagates immediately with no retry logic.

This task adds Sonnet→Opus escalation retry logic: when a Sonnet call fails, the router checks whether the policy's `floorModel` permits Opus. If so, it retries the call with Opus and emits tracking events. This improves reliability for high-priority tasks where Opus is permitted as a fallback.

Key concepts to understand before editing:
- `routedAnthropicCall` is the main dispatch function in `lib/model-router.ts`
- `RoutingDecision` is the return type / tracking object for routing outcomes
- `floorModel` on the routing policy controls the minimum (most capable) model allowed — if `floorModel === 'sonnet'`, Opus is permitted; if `floorModel === 'opus'`, Opus is the only option anyway; if `floorModel` is not set or is `'haiku'`, Sonnet may be selected and Opus is always a valid escalation target
- `emitModelEscalationEvent` may or may not exist yet — see Step 1 for how to handle this
- `model_call` events are already emitted per call; the escalated call must also emit one

Read the actual file before making changes — the exact type signatures and function shapes matter.

## Requirements

1. After a failed Sonnet-routed call, check if the policy's `floorModel` permits Opus escalation (i.e., `floorModel` is not `'sonnet'` — when floor is sonnet, sonnet is the minimum and opus is blocked)
2. If escalation is permitted, retry the same call with the Opus model
3. Emit a `model_escalation` event (via `emitModelEscalationEvent` or equivalent) with `fromModel`, `toModel`, `reason` (error message/type), and `workItemId`
4. Emit a separate `model_call` event for the escalated Opus call (so both attempts are tracked)
5. Set `wasEscalated: true` on the `RoutingDecision` when escalation occurs
6. If the escalated Opus call also fails, throw the error — no further retry
7. Add `maxEscalationRetries` (default `1`) to the routing policy type; currently only 0 or 1 retries are needed but the field future-proofs the config
8. If `floorModel === 'sonnet'`, no escalation occurs and the original Sonnet error propagates immediately
9. All existing behavior for non-failing calls and Opus-routed calls is unchanged
10. TypeScript compiles without errors (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/model-router-sonnet-opus-escalation
```

### Step 1: Read and understand the current model router

Read the full file before making any changes:
```bash
cat lib/model-router.ts
```

Also check for any related event-emission utilities:
```bash
grep -r "emitModelEscalationEvent\|model_escalation\|model_call\|RoutingDecision\|routedAnthropicCall\|floorModel" lib/ --include="*.ts" -l
```

And check types:
```bash
grep -r "RoutingDecision\|RoutingPolicy\|floorModel\|maxEscalation" lib/ --include="*.ts"
```

Note the exact names of:
- The routing policy type/interface
- The `RoutingDecision` type/interface  
- The event emission functions (`emitModelEscalationEvent` — if it doesn't exist, you'll need to create it or inline the event emission using the existing event infrastructure)
- How `model_call` events are currently emitted

### Step 2: Implement escalation logic in `lib/model-router.ts`

Based on your reading of the file, apply the following changes:

**2a. Add `maxEscalationRetries` to the routing policy type:**

Find the routing policy interface/type and add:
```typescript
maxEscalationRetries?: number; // default 1
```

**2b. Add `wasEscalated` to `RoutingDecision` if not present:**

Find the `RoutingDecision` interface/type and add:
```typescript
wasEscalated?: boolean;
```

**2c. Add `emitModelEscalationEvent` if it doesn't already exist:**

If there's no existing escalation event emitter, add a helper near the other event-emission functions:
```typescript
function emitModelEscalationEvent(params: {
  fromModel: string;
  toModel: string;
  reason: string;
  workItemId?: string;
}): void {
  // Use the existing event bus / logging infrastructure already present in the file
  // e.g., if events are emitted via a shared emitEvent or log function, use that
  // If the file has a local emit pattern, follow it exactly
}
```

> **Important:** Match the existing event emission pattern in the file exactly. Do not import new libraries. Use whatever event bus or logging mechanism is already used for `model_call` events.

**2d. Modify `routedAnthropicCall` to add escalation retry:**

The core logic pattern to implement (adapt to the actual function signature and structure):

```typescript
// After determining the selected model is Sonnet and making the call:
try {
  // existing Sonnet call + model_call event emission
  const result = await makeAnthropicCall(/* ... sonnet args ... */);
  emitModelCallEvent({ model: 'sonnet', /* ... */ });
  return result;
} catch (sonnetError: unknown) {
  const maxRetries = policy.maxEscalationRetries ?? 1;
  const canEscalate = maxRetries > 0 && policy.floorModel !== 'sonnet';
  
  if (!canEscalate) {
    throw sonnetError;
  }

  // Emit escalation event
  const reason = sonnetError instanceof Error ? sonnetError.message : String(sonnetError);
  emitModelEscalationEvent({
    fromModel: 'claude-sonnet-...',  // use actual model string from policy/constants
    toModel: 'claude-opus-...',      // use actual model string from policy/constants
    reason,
    workItemId: decision.workItemId, // or however workItemId is threaded through
  });

  // Retry with Opus
  try {
    const escalatedResult = await makeAnthropicCall(/* ... opus args ... */);
    emitModelCallEvent({ model: 'opus', /* ... */ });
    decision.wasEscalated = true;
    return escalatedResult;
  } catch (opusError: unknown) {
    throw opusError; // no further retry
  }
}
```

> **Adapt this skeleton to the actual function structure.** The real implementation depends on how `routedAnthropicCall` is structured — it may use a different call pattern, different model string constants, different ways to pass `workItemId`, etc. Follow the existing patterns precisely.

### Step 3: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues to watch for:
- `wasEscalated` not on the `RoutingDecision` type → add it in the interface
- `maxEscalationRetries` not on policy type → add it in the interface
- `unknown` error type needing a cast → use `instanceof Error` guard

### Step 4: Run existing tests (if any)

```bash
npm test -- --testPathPattern="model-router" 2>/dev/null || echo "No model-router tests found"
npm test 2>/dev/null || echo "No test runner configured"
```

If tests exist, ensure they pass. If the model router has no tests, that's acceptable — do not add tests in this handoff.

### Step 5: Build check

```bash
npm run build
```

Resolve any build errors. Do not proceed to commit if the build fails.

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add Sonnet→Opus escalation retry logic to model router

- After a failed Sonnet call, check floorModel to determine if Opus escalation is permitted
- If permitted (floorModel !== 'sonnet'), retry with Opus and emit model_escalation event
- Both the failed Sonnet call and escalated Opus call emit separate model_call events
- RoutingDecision.wasEscalated is set to true when escalation occurs
- If escalated Opus call also fails, error propagates with no further retry
- Add maxEscalationRetries (default 1) to routing policy for configurability"

git push origin feat/model-router-sonnet-opus-escalation

gh pr create \
  --title "feat: add Sonnet→Opus escalation retry logic to model router" \
  --body "## Summary

Adds automatic Sonnet→Opus escalation retry logic inside \`lib/model-router.ts\`.

## Changes

- **\`lib/model-router.ts\`**: Modified \`routedAnthropicCall\` to catch Sonnet failures, check policy \`floorModel\`, and retry with Opus if permitted
- Added \`wasEscalated?: boolean\` to \`RoutingDecision\` type
- Added \`maxEscalationRetries?: number\` (default 1) to routing policy type
- Added/wired \`emitModelEscalationEvent\` with \`fromModel\`, \`toModel\`, \`reason\`, \`workItemId\`
- Both the failing Sonnet call and the escalated Opus call emit separate \`model_call\` events

## Behavior

| Scenario | Result |
|---|---|
| Sonnet call succeeds | No change from current behavior |
| Sonnet fails, \`floorModel !== 'sonnet'\` | Retry with Opus; emit escalation event; \`wasEscalated=true\` |
| Sonnet fails, \`floorModel === 'sonnet'\` | Error propagates immediately, no escalation |
| Opus (escalated) also fails | Error propagates, no further retry |
| Opus-routed call (no escalation) | No change from current behavior |

## Testing

- TypeScript compiles without errors
- Build passes
" \
  --base main
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/model-router-sonnet-opus-escalation
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed or was ambiguous]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve (e.g., `lib/model-router.ts` does not exist, the routing policy structure is fundamentally different from what this handoff anticipates, or there are unresolvable type conflicts after 3 attempts):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-retry-with-escalation-logic-to-model-router",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/model-router.ts"]
    }
  }'
```