# Agent Forge -- Create inngest-trigger API Route

## Metadata
- **Branch:** `feat/create-inngest-trigger-api-route`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** app/api/agents/inngest-trigger/route.ts

## Context

Agent Forge has a dashboard with a "Run Now" button that needs to trigger Inngest functions on demand. The platform already has:

- An Inngest client at `lib/inngest/client.ts` (instance id: `"agent-forge"`)
- Seven Inngest functions defined in `lib/inngest/` (dispatcher, health-monitor, pm-cycle, plan-pipeline, pipeline-oversight, pm-sweep, housekeeping)
- An existing `inngest-status` API route at `app/api/agents/inngest-status/route.ts` (recently merged) — use it as a coding pattern reference
- Auth via `AGENT_FORGE_API_SECRET` bearer token (used across other API routes)
- An `INNGEST_EVENT_KEY` env var already configured for sending events

The task is to create a new POST route at `app/api/agents/inngest-trigger/route.ts` that the dashboard "Run Now" button calls with a `functionId`, validates it against a registry, and sends the corresponding Inngest event.

**No files overlap with concurrent work** (`lib/__tests__/spike-lifecycle.test.ts` is in a completely different path).

## Requirements

1. Create `app/api/agents/inngest-trigger/route.ts` with a POST handler
2. Define (or import) an `INNGEST_FUNCTION_REGISTRY` mapping `functionId` strings to their Inngest event names
3. Accept `{ functionId: string }` in the JSON request body
4. Validate that `functionId` exists in the registry; return 400 if not
5. Require authentication via Bearer token (`Authorization: Bearer <AGENT_FORGE_API_SECRET>`) or Next.js session; return 401 if unauthorized
6. Use the Inngest client from `lib/inngest/client.ts` to `inngest.send({ name: eventName, data: {} })`
7. Return `{ triggered: true, functionId }` with HTTP 200 on success
8. Return `{ error: "Unknown functionId" }` with HTTP 400 for unrecognized functionId
9. Return `{ error: "Unauthorized" }` with HTTP 401 for unauthenticated requests
10. The event name used must match the `eventName` from the registry for the given `functionId`

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/create-inngest-trigger-api-route
```

### Step 1: Inspect existing patterns

Before writing code, read the following files to understand current conventions:

```bash
cat app/api/agents/inngest-status/route.ts
cat lib/inngest/client.ts
cat lib/inngest/dispatcher.ts
cat lib/inngest/health-monitor.ts
cat lib/inngest/pm-cycle.ts
cat lib/inngest/plan-pipeline.ts
cat lib/inngest/pipeline-oversight.ts
cat lib/inngest/pm-sweep.ts
cat lib/inngest/housekeeping.ts
cat app/api/inngest/route.ts
```

This will reveal:
- The exact Inngest event names used in each function's `trigger` config
- How auth is handled in existing API routes
- Whether a registry already exists somewhere

### Step 2: Determine event names

Each Inngest function is triggered by an event name defined in its `trigger` config (e.g., `{ event: "agent-forge/dispatcher.cycle.requested" }` or similar). Read the function definitions to find the exact event name strings.

If the functions use `cron` triggers rather than event triggers, check if they also have a manual event trigger or whether `inngest.send` with a synthetic event name is the intended pattern. Look at how the existing cron routes (e.g., `app/api/agents/dispatcher/cron/route.ts`) invoke Inngest to understand the event-send pattern.

### Step 3: Create the route file

Create `app/api/agents/inngest-trigger/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/lib/inngest/client";

// Registry mapping functionId → Inngest event name
// Event names must match the trigger.event in each Inngest function definition.
// Update this registry if new Inngest functions are added.
const INNGEST_FUNCTION_REGISTRY: Record<string, { eventName: string; label: string }> = {
  "dispatcher-cycle": {
    eventName: "agent-forge/dispatcher.cycle.requested",  // verify against lib/inngest/dispatcher.ts
    label: "Dispatcher Cycle",
  },
  "health-monitor-cycle": {
    eventName: "agent-forge/health-monitor.cycle.requested",  // verify against lib/inngest/health-monitor.ts
    label: "Health Monitor Cycle",
  },
  "pm-cycle": {
    eventName: "agent-forge/pm.cycle.requested",  // verify against lib/inngest/pm-cycle.ts
    label: "PM Cycle",
  },
  "plan-pipeline": {
    eventName: "agent-forge/plan.pipeline.requested",  // verify against lib/inngest/plan-pipeline.ts
    label: "Plan Pipeline",
  },
  "pipeline-oversight": {
    eventName: "agent-forge/pipeline.oversight.requested",  // verify against lib/inngest/pipeline-oversight.ts
    label: "Pipeline Oversight",
  },
  "pm-sweep": {
    eventName: "agent-forge/pm.sweep.requested",  // verify against lib/inngest/pm-sweep.ts
    label: "PM Sweep",
  },
  "housekeeping": {
    eventName: "agent-forge/housekeeping.requested",  // verify against lib/inngest/housekeeping.ts
    label: "Housekeeping",
  },
};

// Export registry for use by other routes (e.g., inngest-status)
export { INNGEST_FUNCTION_REGISTRY };

export async function POST(request: NextRequest) {
  // Authentication: Bearer token check
  const authHeader = request.headers.get("authorization");
  const apiSecret = process.env.AGENT_FORGE_API_SECRET;

  if (!apiSecret || !authHeader || authHeader !== `Bearer ${apiSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse body
  let body: { functionId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { functionId } = body;

  if (!functionId || typeof functionId !== "string") {
    return NextResponse.json({ error: "Missing functionId" }, { status: 400 });
  }

  const entry = INNGEST_FUNCTION_REGISTRY[functionId];
  if (!entry) {
    return NextResponse.json(
      { error: `Unknown functionId: ${functionId}` },
      { status: 400 }
    );
  }

  // Send event to Inngest
  await inngest.send({
    name: entry.eventName,
    data: {},
  });

  return NextResponse.json({ triggered: true, functionId }, { status: 200 });
}
```

**IMPORTANT:** The event name strings in the registry above are placeholders. You MUST replace them with the actual event names from each Inngest function's `trigger` config after reading the source files in Step 1. If a function uses only a `cron` trigger (no `event` trigger), check the existing cron route for that agent to see how it currently sends a manual trigger event — use that same event name.

### Step 4: Handle cron-only functions

If any Inngest functions use only `cron` triggers and have no event trigger defined, you have two options:

**Option A (preferred):** Check if the thin cron routes (e.g., `app/api/agents/dispatcher/cron/route.ts`) already send an Inngest event — use the same event name.

**Option B:** If truly cron-only with no event trigger, omit that function from the registry for now and add a comment explaining why. Do not add dummy event names that won't work.

### Step 5: TypeScript validation

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- `inngest.send` type signature — check what `lib/inngest/client.ts` exports and how existing routes call it
- Import path aliases — use `@/lib/inngest/client` or relative `../../../lib/inngest/client` based on what the existing routes use

### Step 6: Build check

```bash
npm run build
```

Fix any build errors before proceeding.

### Step 7: Verification

Manually verify the logic is correct:

```bash
# Confirm the route file exists
ls -la app/api/agents/inngest-trigger/route.ts

# Confirm all event names in the registry actually exist in the function definitions
grep -r "event:" lib/inngest/*.ts | grep -v "node_modules"
grep -r "trigger" lib/inngest/*.ts | grep -v "node_modules"
```

Cross-reference every `eventName` in your registry against the actual trigger event names found in the grep output. Fix any mismatches.

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: create inngest-trigger API route for Run Now button"
git push origin feat/create-inngest-trigger-api-route
gh pr create \
  --title "feat: create inngest-trigger API route" \
  --body "## Summary

Creates \`POST /api/agents/inngest-trigger\` — the endpoint used by the dashboard 'Run Now' button to trigger Inngest functions on demand.

## Changes
- New file: \`app/api/agents/inngest-trigger/route.ts\`

## Behavior
- Accepts \`{ functionId: string }\` in request body
- Validates \`functionId\` against \`INNGEST_FUNCTION_REGISTRY\`
- Requires \`Authorization: Bearer <AGENT_FORGE_API_SECRET>\` header
- Sends corresponding Inngest event via \`inngest.send()\`
- Returns \`{ triggered: true, functionId }\` on success
- Returns 400 for unknown functionId, 401 for unauthorized

## Acceptance Criteria
- [x] POST with valid functionId sends Inngest event and returns 200
- [x] Unknown functionId returns 400
- [x] Unauthenticated requests return 401
- [x] Event name matches registry eventName for the given functionId
- [x] Response body includes \`{ triggered: true, functionId }\` on success"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/create-inngest-trigger-api-route
FILES CHANGED: [app/api/agents/inngest-trigger/route.ts]
SUMMARY: [what was done]
ISSUES: [what failed — e.g., "Could not determine event names for cron-only functions", "inngest.send type mismatch"]
NEXT STEPS: [e.g., "Verify event names in lib/inngest/*.ts match registry entries", "Check if session auth should be used instead of/in addition to bearer token"]
```

## Escalation

If blocked on any of the following, escalate via the API before aborting:

- Cannot determine the correct Inngest event names (all functions are cron-only with no event trigger defined)
- `inngest.send` type signature is incompatible and there is no clear pattern in existing code
- `AGENT_FORGE_API_SECRET` auth pattern differs significantly from what other routes use and the correct approach is ambiguous

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "create-inngest-trigger-api-route",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/api/agents/inngest-trigger/route.ts"]
    }
  }'
```