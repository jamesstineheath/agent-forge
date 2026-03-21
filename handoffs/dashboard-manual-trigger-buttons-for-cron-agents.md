<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- Dashboard: Manual Trigger Buttons for Cron Agents

## Metadata
- **Branch:** `feat/dashboard-agent-trigger-buttons`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** `app/api/agents/trigger/route.ts`, `app/agents/page.tsx` (or equivalent agents dashboard page), `lib/hooks.ts`

## Context

The Agent Forge dashboard has an Agents page showing the 4–5 autonomous cron agents (Dispatcher, Health Monitor, Project Manager, Supervisor, Digest). Currently there is no way to manually trigger an agent run from the UI — operators must wait for the scheduled cron interval or trigger via raw API calls.

This task adds a "Run Now" button next to each agent on the dashboard. The button:
1. Calls a new server-side `/api/agents/trigger` route (authenticated via Auth.js session)
2. That route internally calls the agent's cron endpoint with `CRON_SECRET` auth
3. The UI shows a loading spinner while waiting, then displays success/failure + duration

The 5 cron routes from `vercel.json` to support:
- Dispatcher: `/api/agents/dispatcher/cron`
- Health Monitor: `/api/agents/health-monitor/cron`
- Project Manager: `/api/pm-agent`
- Supervisor: `/api/agents/supervisor/cron`
- Digest: `/api/agents/digest/cron`

**Supervisor note:** Supervisor cycles can take 5–7 minutes. Set a 10-minute client timeout and a generous `maxDuration` on the trigger route. Do not abort early — let it complete.

**Concurrent work awareness:** There is concurrent work on branch for `decomposition-fetch-timeout`. That work touches supervisor phase routes and possibly `lib/atc/supervisor.ts`. This task should **not** modify those files. The trigger route calls agent cron routes as black boxes, so there is no overlap risk. Avoid modifying `app/api/agents/supervisor/cron/route.ts` or `lib/atc/supervisor.ts`.

## Requirements

1. A new API route `POST /api/agents/trigger` exists and:
   - Requires a valid Auth.js session (returns 401 if unauthenticated)
   - Accepts a JSON body `{ agent: string }` where agent is one of: `dispatcher`, `health-monitor`, `project-manager`, `supervisor`, `digest`
   - Returns 400 for unknown agent names
   - Internally calls the agent's cron route via `fetch` with `Authorization: Bearer ${CRON_SECRET}` header
   - Returns `{ success: boolean, duration: number, status: number, body?: string }` to the client
   - Has `export const maxDuration = 700` to handle supervisor's long cycles
2. The Agents dashboard page shows a "Run Now" button for each of the 5 agents
3. Clicking "Run Now" shows a loading/spinner state while the request is in flight
4. After completion, a success or failure result (including duration in seconds) is shown inline next to the button
5. The "last triggered" time is shown after a successful trigger (client-side state is sufficient; no persistence required)
6. The trigger button is disabled while an agent is running (prevents double-submit)
7. Dashboard auth is enforced — the UI button is only visible to authenticated users (consistent with existing auth patterns)
8. TypeScript compiles with no errors (`npx tsc --noEmit`)
9. The feature works when `CRON_SECRET` is set in the environment

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/dashboard-agent-trigger-buttons
```

### Step 1: Explore the existing codebase

Before writing any code, understand the current structure:

```bash
# Find the agents dashboard page
find app -name "*.tsx" | xargs grep -l -i "agent" | head -20
find app -name "*.tsx" | xargs grep -l -i "dispatcher\|health.monitor\|supervisor" | head -10

# Check existing API route patterns for auth
cat app/api/work-items/route.ts 2>/dev/null || true
find app/api -name "route.ts" | head -10 | xargs head -30

# Check Auth.js session pattern used in API routes
grep -r "getServerSession\|auth()\|getSession" app/api --include="*.ts" -l | head -5
grep -r "getServerSession\|auth()\|getSession" app/api --include="*.ts" -A3 | head -40

# Check how the dashboard pages fetch data and render agent info
find app -path "*/agents*" -name "*.tsx" | head -10
ls app/agents/ 2>/dev/null || ls app/dashboard/ 2>/dev/null || ls app/ | head -20

# Check vercel.json for cron route confirmation
cat vercel.json | grep -A2 "cron\|path"

# Check existing hooks for data fetching patterns
head -100 lib/hooks.ts

# Check if there's a shared UI component library
ls components/ 2>/dev/null || ls app/components/ 2>/dev/null || true
```

### Step 2: Create the `/api/agents/trigger` route

Create `app/api/agents/trigger/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth"; // adjust import path to match existing auth pattern

// Allow long-running supervisor cycles (up to ~10 min)
export const maxDuration = 700;

const AGENT_ROUTES: Record<string, string> = {
  dispatcher: "/api/agents/dispatcher/cron",
  "health-monitor": "/api/agents/health-monitor/cron",
  "project-manager": "/api/pm-agent",
  supervisor: "/api/agents/supervisor/cron",
  digest: "/api/agents/digest/cron",
};

export async function POST(req: NextRequest) {
  // Require authenticated session
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { agent?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { agent } = body;
  if (!agent || !AGENT_ROUTES[agent]) {
    return NextResponse.json(
      {
        error: `Unknown agent. Valid agents: ${Object.keys(AGENT_ROUTES).join(", ")}`,
      },
      { status: 400 }
    );
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 }
    );
  }

  const cronRoute = AGENT_ROUTES[agent];
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  const url = `${baseUrl}${cronRoute}`;

  const start = Date.now();
  let responseStatus = 0;
  let responseBody = "";
  let success = false;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "Content-Type": "application/json",
      },
    });

    responseStatus = response.status;
    // Read body but cap at 2KB to avoid memory issues
    const text = await response.text();
    responseBody = text.slice(0, 2048);
    success = response.ok;
  } catch (err) {
    responseBody = err instanceof Error ? err.message : "Unknown fetch error";
    success = false;
  }

  const duration = Math.round((Date.now() - start) / 1000);

  return NextResponse.json({
    success,
    duration,
    status: responseStatus,
    body: responseBody,
  });
}
```

**Important:** Check how existing API routes import `auth` — it may be:
- `import { auth } from "@/auth"` 
- `import { getServerSession } from "next-auth"`
- `import { authOptions } from "@/lib/auth"`

Match the exact pattern used in adjacent route files.

Also check whether the base URL should come from `process.env.VERCEL_URL`, `NEXT_PUBLIC_APP_URL`, or another env var. Check `.env.example` or other routes that make internal fetches.

### Step 3: Locate the agents dashboard page and understand its structure

```bash
# Find where agent info is rendered
find app -name "*.tsx" -o -name "*.jsx" | xargs grep -l "Dispatcher\|dispatcher\|cron agent\|Run Now" 2>/dev/null | head -10

# Check the page structure
cat app/agents/page.tsx 2>/dev/null || \
cat app/dashboard/agents/page.tsx 2>/dev/null || \
find app -name "page.tsx" | xargs grep -l -i "agent\|dispatcher" 2>/dev/null | head -3
```

Identify the exact file path for the agents dashboard page before proceeding.

### Step 4: Add the AgentTriggerButton component

Create a reusable client component at `components/AgentTriggerButton.tsx` (or `app/components/AgentTriggerButton.tsx` — match the project's component location convention):

```typescript
"use client";

import { useState } from "react";

interface TriggerResult {
  success: boolean;
  duration: number;
  status: number;
  body?: string;
}

interface AgentTriggerButtonProps {
  agentKey: string; // e.g. "dispatcher", "health-monitor"
  agentName: string; // display name e.g. "Dispatcher"
}

export function AgentTriggerButton({
  agentKey,
  agentName,
}: AgentTriggerButtonProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TriggerResult | null>(null);
  const [lastTriggered, setLastTriggered] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleTrigger = async () => {
    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const res = await fetch("/api/agents/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: agentKey }),
        // 10 minute client timeout for supervisor
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });

      const data: TriggerResult = await res.json();
      setResult(data);
      if (data.success) {
        setLastTriggered(new Date());
      }
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        setError("Timed out after 10 minutes");
      } else {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          onClick={handleTrigger}
          disabled={loading}
          className={[
            "inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors",
            loading
              ? "cursor-not-allowed bg-gray-100 text-gray-400"
              : "bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800",
          ].join(" ")}
          title={`Manually trigger ${agentName}`}
        >
          {loading ? (
            <>
              <svg
                className="h-3.5 w-3.5 animate-spin"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              Running…
            </>
          ) : (
            "Run Now"
          )}
        </button>

        {result && (
          <span
            className={[
              "text-xs font-medium",
              result.success ? "text-green-600" : "text-red-600",
            ].join(" ")}
          >
            {result.success
              ? `✓ Done in ${result.duration}s`
              : `✗ Failed (HTTP ${result.status}, ${result.duration}s)`}
          </span>
        )}

        {error && (
          <span className="text-xs font-medium text-red-600">✗ {error}</span>
        )}
      </div>

      {lastTriggered && (
        <p className="text-xs text-gray-400">
          Last run: {lastTriggered.toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}
```

**Note on styling:** Check the existing dashboard components for their Tailwind class patterns. If the project uses a different design system (e.g., shadcn/ui, custom classes), adjust the classes to match. The functional behavior is what matters.

### Step 5: Integrate the trigger button into the agents dashboard page

Open the agents dashboard page found in Step 3. Add the `AgentTriggerButton` component next to each agent's row/card.

The agent key mapping to use:
```typescript
const AGENTS = [
  { key: "dispatcher",       name: "Dispatcher",      route: "/api/agents/dispatcher/cron",  cadence: "5 min" },
  { key: "health-monitor",   name: "Health Monitor",  route: "/api/agents/health-monitor/cron", cadence: "5 min" },
  { key: "project-manager",  name: "Project Manager", route: "/api/pm-agent",                cadence: "15 min" },
  { key: "supervisor",       name: "Supervisor",      route: "/api/agents/supervisor/cron",  cadence: "10 min" },
  { key: "digest",           name: "Digest",          route: "/api/agents/digest/cron",      cadence: "daily" },
];
```

If the page is a server component, it may need to be split: keep the server component for data fetching and add the `AgentTriggerButton` (client component, already marked `"use client"`) inline. Server components can render client components directly.

If the page already uses `"use client"`, simply import and render `AgentTriggerButton` where appropriate.

Example integration pattern (adapt to actual page structure):
```tsx
import { AgentTriggerButton } from "@/components/AgentTriggerButton";
// or wherever components live

// Inside the agent row/card render:
<AgentTriggerButton agentKey={agent.key} agentName={agent.name} />
```

### Step 6: Handle the Digest agent gracefully

The Digest agent (`/api/agents/digest/cron`) may or may not exist in the codebase. Check:

```bash
ls app/api/agents/digest/ 2>/dev/null
cat vercel.json | grep digest
```

If the route does not exist yet, either:
- **Option A (preferred):** Keep `digest` in the `AGENT_ROUTES` map but render the button with a `disabled` prop and tooltip "Not yet implemented" if the route returns 404
- **Option B:** Remove `digest` from `AGENT_ROUTES` and the UI agent list if it does not exist in `vercel.json`

Check `vercel.json` to confirm which of the 5 routes are actually defined, and only include existing ones.

### Step 7: Verify auth import pattern

```bash
# Check what auth export the project uses
grep -r "from.*auth" app/api --include="*.ts" | grep -v node_modules | head -20
cat auth.ts 2>/dev/null || cat app/auth.ts 2>/dev/null || cat lib/auth.ts 2>/dev/null | head -30
```

Ensure the trigger route uses the exact same auth pattern as other protected API routes. Common patterns:

```typescript
// Pattern A: Auth.js v5
import { auth } from "@/auth";
const session = await auth();
if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

// Pattern B: next-auth v4
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
const session = await getServerSession(authOptions);
if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
```

### Step 8: Check base URL resolution for internal fetch

```bash
# Find how other routes make internal fetches (if any)
grep -r "VERCEL_URL\|NEXT_PUBLIC_APP_URL\|localhost:3000" app lib --include="*.ts" | grep -v node_modules | head -20

# Check env variable names in use
cat .env.example 2>/dev/null || cat .env.local.example 2>/dev/null || true
```

Update the base URL logic in `app/api/agents/trigger/route.ts` to match what the project actually uses. If no internal fetches exist elsewhere, the `VERCEL_URL` → `NEXT_PUBLIC_APP_URL` → `localhost:3000` fallback chain is a safe default.

### Step 9: TypeScript verification

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues:
- Missing return type on async functions (add `Promise<NextResponse>`)
- `AbortSignal.timeout` may not be in older TS lib targets — if so, use a `setTimeout`-based AbortController instead:

```typescript
// Fallback for older TS targets
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 10 * 60 * 1000);
try {
  const res = await fetch("/api/agents/trigger", {
    signal: controller.signal,
    // ...
  });
} finally {
  clearTimeout(timeoutId);
}
```

### Step 10: Build verification

```bash
npm run build
```

Resolve any build errors. The most likely issues:
- Component not marked `"use client"` when using hooks
- Server component trying to use browser APIs
- Missing export from component file

### Step 11: Manual smoke test checklist

Since this is a UI feature, document what to verify manually after deployment:
- [ ] Unauthenticated request to `POST /api/agents/trigger` returns 401
- [ ] `POST /api/agents/trigger` with `{ agent: "unknown" }` returns 400
- [ ] `POST /api/agents/trigger` with `{ agent: "dispatcher" }` returns success/failure JSON
- [ ] Dashboard shows "Run Now" button for each agent
- [ ] Button shows spinner while in-flight
- [ ] Result (✓/✗ + duration) appears after completion
- [ ] "Last run" timestamp appears after success
- [ ] Button is disabled while running (no double-trigger)

### Step 12: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add Run Now trigger buttons for cron agents on dashboard

- Add POST /api/agents/trigger route (auth-gated, calls cron routes with CRON_SECRET)
- Add AgentTriggerButton client component with loading/success/failure states
- Integrate trigger buttons into agents dashboard page for all 5 cron agents
- maxDuration=700 on trigger route to support long supervisor cycles"

git push origin feat/dashboard-agent-trigger-buttons

gh pr create \
  --title "feat: Dashboard manual trigger buttons for cron agents" \
  --body "## Summary
Adds a \"Run Now\" button next to each cron agent on the Agents dashboard page.

## Changes
- \`app/api/agents/trigger/route.ts\` — New auth-gated API route that proxies cron triggers with CRON_SECRET
- \`components/AgentTriggerButton.tsx\` — Client component with loading/success/failure/timeout states
- \`app/agents/page.tsx\` (or equivalent) — Integrates trigger buttons into agent rows

## Agents supported
| Agent | Route |
|-------|-------|
| Dispatcher | /api/agents/dispatcher/cron |
| Health Monitor | /api/agents/health-monitor/cron |
| Project Manager | /api/pm-agent |
| Supervisor | /api/agents/supervisor/cron |
| Digest | /api/agents/digest/cron |

## Notes
- Trigger route requires valid Auth.js session (401 if unauthenticated)
- maxDuration=700s handles supervisor's 5-7 min cycles
- Client-side 10-minute timeout via AbortSignal
- No files modified that overlap with concurrent decomposition-fetch-timeout work"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/dashboard-agent-trigger-buttons
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

Common blockers and resolutions:
- **Can't find agents dashboard page:** Search for any page with "Dispatcher" or "cron" in content; check `app/dashboard/`, `app/agents/`, or `app/(dashboard)/agents/`
- **Auth import fails:** Check `package.json` for `next-auth` version and match the correct import style
- **`AbortSignal.timeout` TS error:** Use `setTimeout` + `AbortController` fallback (see Step 9)
- **Digest route doesn't exist:** Remove from AGENT_ROUTES and UI list; note in PR description

If escalation is needed:
```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "<work-item-id>",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/api/agents/trigger/route.ts", "components/AgentTriggerButton.tsx"]
    }
  }'
```