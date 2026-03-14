# Handoff 14v2: Work Items API Key Auth for External Callers

## Metadata
- **Branch:** `feat/work-items-api-key-auth-v2`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $3
- **Risk Level:** low
- **Complexity:** simple
- **Depends On:** None
- **Date:** 2026-03-14
- **Executor:** Claude Code (GitHub Actions)

## Context

This is a re-draft of handoff 14 (PR #16), which has merge conflicts after PRs #17-19 landed. The change is identical in intent: add Bearer token auth to the work items API so the PA can call it server-to-server.

The PA's `file_work_item` bridge tool (PR #244) is already merged and deployed. It calls `POST /api/work-items` with `Authorization: Bearer <WORK_ITEMS_API_KEY>`. The Agent Forge endpoint currently only accepts Auth.js session cookies, so the bridge tool gets 401s. This handoff fixes that.

The escalation endpoint (`app/api/escalations/route.ts`) already has inline Bearer token auth via `validateBearerToken()` using `ESCALATION_SECRET`. The pattern is proven.

## Pre-flight Self-Check

Before starting any code changes, verify ALL of these exist. If any are missing, **abort immediately**.

- [ ] `app/api/work-items/route.ts` exists with GET and POST handlers
- [ ] `app/api/escalations/route.ts` exists with `validateBearerToken()` function
- [ ] `lib/types.ts` has `createWorkItemSchema`
- [ ] `lib/decomposer.ts` exists (from PR #17, confirms we're on current main)
- [ ] No open PRs touch `app/api/work-items/route.ts`

## Step 0: Branch, commit handoff, push

Create branch `feat/work-items-api-key-auth-v2` from main, commit this handoff file, push.

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
      return null;
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
```

## Step 2: Update work items route

Modify `app/api/work-items/route.ts`:
- Import `validateAuth` from `@/lib/api-auth`
- Replace any inline `auth()` checks in GET and POST with `validateAuth(req, "WORK_ITEMS_API_KEY")`
- Ensure the route handler signatures accept `req: NextRequest`

## Step 3: Update work items [id] route

If `app/api/work-items/[id]/route.ts` exists and uses `auth()`, apply the same pattern.

## Step 4: Migrate escalations route to shared helper

Refactor `app/api/escalations/route.ts` to use `validateAuth(req, "ESCALATION_SECRET")` instead of its inline `validateBearerToken()`. Remove the local function. This consolidates auth.

If `app/api/escalations/[id]/route.ts` exists with its own auth check, migrate that too.

## Step 5: Verify build

Run `npm run build`. Fix any TypeScript errors.

## Step 6: Update docs

Add a note to `CLAUDE.md` documenting that `/api/work-items` accepts Bearer token auth via `WORK_ITEMS_API_KEY` env var.

## Session Abort Protocol

If any step fails and cannot be resolved within 3 attempts:
1. Commit all working changes with prefix `wip: `
2. Push the branch
3. Open a draft PR with description of what worked and what failed
4. Output structured JSON: `{"status": "aborted", "step": <N>, "reason": "..."}`

## Post-merge Note

`WORK_ITEMS_API_KEY` env var is already set on both Vercel projects. No manual action needed after merge. Close PR #16 as superseded.
