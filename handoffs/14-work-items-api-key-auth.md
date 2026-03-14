# Handoff 14: Work Items API Key Auth for External Callers

## Metadata
- **Branch:** `feat/work-items-api-key-auth`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $3
- **Risk Level:** low
- **Complexity:** simple
- **Depends On:** None (all prerequisites already merged)
- **Date:** 2026-03-14
- **Executor:** Claude Code (GitHub Actions)

## Context

Agent Forge's `/api/work-items` POST endpoint currently requires Auth.js session authentication (Google OAuth cookies). This works for the dashboard UI but prevents server-to-server calls from external systems like the PA.

Phase 2c (PA Improvements Pipeline Removal) requires the PA to file work items into Agent Forge via API. The PA needs a Bearer token auth path on the work items POST endpoint, identical to the pattern already used by `/api/escalations/route.ts` with `ESCALATION_SECRET`.

This is the first of 4 handoffs for Phase 2c. The PA-side handoffs (file_work_item tool, caller migration, dead code removal) depend on this endpoint accepting API key auth.

## Reference Implementation

`app/api/escalations/route.ts` already implements the exact pattern needed:
- `validateBearerToken()` checks `Authorization: Bearer <secret>` header against an env var
- Returns 401 if missing/invalid, 500 if env var not configured
- Both GET and POST use it

## Pre-flight Self-Check

Before starting any code changes, verify ALL of these exist. If any are missing, **abort immediately** and report which dependency is missing.

- [ ] `app/api/work-items/route.ts` exists with GET and POST handlers using `auth()` from `@/lib/auth`
- [ ] `app/api/escalations/route.ts` exists with `validateBearerToken()` function
- [ ] `lib/types.ts` has `createWorkItemSchema` with Zod validation
- [ ] No open PRs touch `app/api/work-items/route.ts`

## Step 0: Branch, commit handoff, push

Create branch `feat/work-items-api-key-auth` from main, commit this handoff file, push.

## Step 1: Extract shared API auth helper

Create `lib/api-auth.ts` with a reusable auth helper that accepts either session auth OR Bearer token:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

/**
 * Validate request via either:
 * 1. Bearer token (for server-to-server calls from PA, pipeline agents)
 * 2. Auth.js session (for dashboard UI)
 *
 * Returns null if authorized, or an error NextResponse if not.
 */
export async function validateAuth(
  req: NextRequest,
  secretEnvVar: string
): Promise<NextResponse | null> {
  // Check Bearer token first (server-to-server)
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const secret = process.env[secretEnvVar];
    if (!secret) {
      console.error(`[api-auth] ${secretEnvVar} not configured`);
      return NextResponse.json(
        { error: `Server misconfiguration: ${secretEnvVar} not set` },
        { status: 500 }
      );
    }
    if (authHeader === `Bearer ${secret}`) {
      return null; // Authorized via API key
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fall back to session auth (dashboard UI)
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
```

## Step 2: Update work items route to use shared auth

Modify `app/api/work-items/route.ts`:
- Replace the inline `auth()` checks in both GET and POST with `validateAuth(req, "WORK_ITEMS_API_KEY")`
- Import `validateAuth` from `@/lib/api-auth`
- Remove the direct `auth` import from `@/lib/auth`

## Step 3: Update work items [id] route

Check `app/api/work-items/[id]/route.ts` and apply the same pattern if it uses `auth()` directly.

## Step 4: Migrate escalations route to shared helper

Refactor `app/api/escalations/route.ts` to use `validateAuth(req, "ESCALATION_SECRET")` instead of its inline `validateBearerToken()`. Remove the local `validateBearerToken` function. This consolidates auth into one place.

## Step 5: Verify build

Run `npm run build` and ensure no TypeScript errors. The app should build cleanly.

## Step 6: Update docs

Add a note to `CLAUDE.md` or `docs/SYSTEM_MAP.md` (whichever documents API routes) that `/api/work-items` now accepts Bearer token auth via `WORK_ITEMS_API_KEY` env var, in addition to session auth.

## Session Abort Protocol

If any step fails and cannot be resolved within 3 attempts:
1. Commit all working changes with prefix `wip: `
2. Push the branch
3. Open a draft PR with a description of what worked and what failed
4. Output structured JSON: `{"status": "aborted", "step": <N>, "reason": "..."}`

## Post-merge Note

After this PR merges, a new Vercel env var `WORK_ITEMS_API_KEY` must be set before the PA can use the endpoint. Generate a secure random value and add it to both:
- Agent Forge Vercel project: `WORK_ITEMS_API_KEY`
- PA Vercel project: `AGENT_FORGE_WORK_ITEMS_API_KEY` (same value)
