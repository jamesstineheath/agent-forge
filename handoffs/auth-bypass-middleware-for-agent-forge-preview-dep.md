# Agent Forge -- Auth Bypass Middleware for Preview Deployments

## Metadata
- **Branch:** `feat/preview-auth-bypass`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** middleware.ts

## Context

Agent Forge uses Auth.js v5 (next-auth@beta) with Google OAuth for authentication. All app routes under `app/(app)/` are protected. The QA Agent needs to test authenticated routes in Vercel Preview deployments, but cannot go through the Google OAuth flow headlessly.

The solution is a preview-only auth bypass in `middleware.ts` that checks for a secret token header and injects a synthetic authenticated session — identical to the pattern used in the Personal Assistant repo. This bypass is a no-op in production (`VERCEL_ENV === 'production'`) and only activates when:
1. `VERCEL_ENV === 'preview'`
2. The `X-QA-Agent-Token` request header is present
3. The header value matches `process.env.QA_BYPASS_SECRET`

Auth.js v5 middleware uses `auth()` from `./auth` and the session is stored as a JWT. The bypass works by returning a `NextResponse` with a forged `next-auth.session-token` cookie that encodes a valid session payload.

**Manual prerequisite (human action required before this is useful):** Set `QA_BYPASS_SECRET` as a Vercel environment variable scoped to Preview environments only. This handoff does not set that env var — it only implements the middleware logic.

## Requirements

1. `middleware.ts` exists at the repo root and handles the preview auth bypass
2. Bypass is active only when `process.env.VERCEL_ENV === 'preview'` AND `X-QA-Agent-Token` header is present AND its value equals `process.env.QA_BYPASS_SECRET`
3. When bypass conditions are met, the request proceeds as authenticated with session user `james.stine.heath@gmail.com`
4. No behavior change in production — bypass code path is entirely gated on `VERCEL_ENV === 'preview'`
5. All existing auth behavior (redirecting unauthenticated users, protecting app routes) is preserved for normal requests
6. Code comment documents the bypass pattern clearly for replication in other repos
7. TypeScript compiles without errors (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/preview-auth-bypass
```

### Step 1: Inspect existing middleware and auth configuration

Check if `middleware.ts` already exists and review the current auth setup:

```bash
# Check for existing middleware
ls middleware.ts 2>/dev/null && cat middleware.ts || echo "No middleware.ts found"

# Review auth configuration
cat lib/auth.ts

# Check next-auth version and installed packages
cat package.json | grep -E "(next-auth|@auth)"

# Check .env.example or .env.local for existing env var patterns
ls .env* 2>/dev/null && cat .env.example 2>/dev/null || true
```

Note the exact export/import pattern used in `lib/auth.ts`. Auth.js v5 typically exports `auth`, `handlers`, `signIn`, `signOut`. The middleware wraps `auth()`.

### Step 2: Implement middleware.ts

Create (or replace) `middleware.ts` at the repo root with the following implementation. **Read `lib/auth.ts` first** to confirm the exact export names before writing.

```typescript
/**
 * middleware.ts — Next.js Edge Middleware for Agent Forge
 *
 * AUTH BYPASS PATTERN (preview environments only):
 * ─────────────────────────────────────────────────
 * For QA Agent testing of authenticated routes in Vercel Preview deployments,
 * we support a token-based auth bypass. This pattern can be replicated in any
 * repo that uses Auth.js v5 with the same three-condition check:
 *
 *   1. process.env.VERCEL_ENV === 'preview'
 *   2. Request header 'X-QA-Agent-Token' is present
 *   3. Header value matches process.env.QA_BYPASS_SECRET
 *
 * When all conditions are met, we set a synthetic next-auth session cookie so
 * the request is treated as authenticated for james.stine.heath@gmail.com.
 *
 * IMPORTANT: QA_BYPASS_SECRET must be set as a Vercel env var scoped to
 * Preview environments only. It must NOT be set in Production.
 *
 * This bypass is a strict no-op in production — the VERCEL_ENV check ensures
 * the bypass code path cannot execute in a production deployment.
 */

import { auth } from './lib/auth';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Checks if an incoming request qualifies for the QA Agent auth bypass.
 * Returns true only in preview environments with a valid bypass token.
 */
function isQABypassRequest(request: NextRequest): boolean {
  // Gate 1: Must be a Vercel Preview deployment
  if (process.env.VERCEL_ENV !== 'preview') {
    return false;
  }

  // Gate 2: QA_BYPASS_SECRET must be configured
  const bypassSecret = process.env.QA_BYPASS_SECRET;
  if (!bypassSecret) {
    return false;
  }

  // Gate 3: Request must carry the bypass header with matching value
  const tokenHeader = request.headers.get('X-QA-Agent-Token');
  if (!tokenHeader || tokenHeader !== bypassSecret) {
    return false;
  }

  return true;
}

export default auth((request) => {
  const { nextUrl, auth: session } = request as NextRequest & { auth: unknown };

  // --- QA Agent Preview Auth Bypass ---
  if (isQABypassRequest(request)) {
    // Allow the request through as if authenticated.
    // Auth.js v5 session validation happens at the page/API layer via getServerSession();
    // by passing through here without redirect, protected routes will attempt to read
    // the session. To inject a full session, we set the session cookie below.
    const response = NextResponse.next();

    // Signal to the app that this is a bypassed request.
    // The actual session injection relies on a forged session cookie.
    // We set a lightweight indicator header for debugging.
    response.headers.set('X-QA-Bypass-Active', '1');

    return response;
  }

  // --- Standard Auth.js protection ---
  // Redirect unauthenticated users to sign-in for protected routes.
  const isAuthenticated = !!session;
  const isAuthRoute = nextUrl.pathname.startsWith('/sign-in') ||
    nextUrl.pathname.startsWith('/api/auth');

  if (!isAuthenticated && !isAuthRoute) {
    const signInUrl = new URL('/sign-in', nextUrl.origin);
    signInUrl.searchParams.set('callbackUrl', nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - public folder assets
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
```

**IMPORTANT — Auth.js v5 session injection approach:**

Auth.js v5 middleware works differently from v4. The `auth()` wrapper provides the session via `request.auth`. Simply passing through without redirect is not sufficient to make downstream `auth()` calls return a session.

After writing the initial file above, **check how `lib/auth.ts` exports things** and whether there's a `SESSION_SECRET` / `AUTH_SECRET` environment variable. Then update the bypass to also set a forged JWT cookie if needed.

A more robust bypass implementation sets the `authjs.session-token` cookie with a minimal JWT. Here is the enhanced version to use if the simpler pass-through doesn't work for your Auth.js v5 setup:

```typescript
import { SignJWT } from 'jose';

/**
 * Creates a minimal Auth.js v5 compatible session JWT for the bypass user.
 * The AUTH_SECRET env var is used to sign the token (same as Auth.js uses internally).
 */
async function createBypassSessionCookie(): Promise<string | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;

  const encoder = new TextEncoder();
  const secretKey = encoder.encode(secret);

  const payload = {
    user: {
      name: 'James Heath',
      email: 'james.stine.heath@gmail.com',
      image: null,
    },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
  };

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secretKey);

  return token;
}
```

**Decision for implementation:** Read `lib/auth.ts` to understand the session strategy (JWT vs database). If JWT strategy is used (likely, given Vercel Blob storage pattern), implement the full cookie injection. If it's unclear, implement the simpler pass-through first, then add the JWT injection.

### Step 3: Write the final middleware.ts

Based on what you found in Step 1, write the final `middleware.ts`. Here is the complete recommended implementation using JWT cookie injection (works with Auth.js v5 JWT strategy):

```typescript
/**
 * middleware.ts — Next.js Edge Middleware for Agent Forge
 *
 * AUTH BYPASS PATTERN (preview environments only):
 * ─────────────────────────────────────────────────
 * For QA Agent testing of authenticated routes in Vercel Preview deployments,
 * we support a token-based auth bypass. To replicate this pattern in another repo:
 *
 *   1. Add this middleware.ts to the repo root
 *   2. Set QA_BYPASS_SECRET as a Vercel env var (Preview scope only)
 *   3. QA Agent sends header: X-QA-Agent-Token: <QA_BYPASS_SECRET>
 *
 * Three conditions must ALL be true for bypass to activate:
 *   1. process.env.VERCEL_ENV === 'preview'
 *   2. X-QA-Agent-Token header is present
 *   3. Header value === process.env.QA_BYPASS_SECRET
 *
 * The bypass injects a signed JWT session cookie (same format Auth.js v5 uses)
 * so downstream auth() calls see a valid session for james.stine.heath@gmail.com.
 *
 * SECURITY: QA_BYPASS_SECRET must NOT be set in Production. The VERCEL_ENV check
 * provides defense-in-depth, but keeping the secret out of production is essential.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { auth } from './lib/auth';
import { SignJWT } from 'jose';

// Auth.js v5 uses 'authjs.session-token' as the cookie name in production
// and '__Secure-authjs.session-token' on HTTPS. In preview we use the non-secure name.
const SESSION_COOKIE_NAME = 'authjs.session-token';

/**
 * Returns true if this request should use the QA Agent auth bypass.
 * Strictly no-ops in production.
 */
function isQABypassRequest(request: NextRequest): boolean {
  if (process.env.VERCEL_ENV !== 'preview') return false;

  const secret = process.env.QA_BYPASS_SECRET;
  if (!secret) return false;

  const token = request.headers.get('X-QA-Agent-Token');
  return token === secret;
}

/**
 * Creates a minimal Auth.js v5-compatible JWT session for the QA bypass user.
 * Signed with AUTH_SECRET so Auth.js accepts it as a valid session token.
 */
async function createBypassSessionToken(): Promise<string | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;

  const key = new TextEncoder().encode(secret);

  return new SignJWT({
    user: {
      name: 'James Heath',
      email: 'james.stine.heath@gmail.com',
      image: null,
    },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(key);
}

export default auth(async (request) => {
  // QA Agent preview bypass — must be checked before standard auth logic
  if (isQABypassRequest(request)) {
    const sessionToken = await createBypassSessionToken();

    if (sessionToken) {
      // Forge the session cookie so downstream auth() calls see a valid session
      const response = NextResponse.next();
      response.cookies.set(SESSION_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        // maxAge matches the JWT expiry (24h)
        maxAge: 60 * 60 * 24,
      });
      response.headers.set('X-QA-Bypass-Active', '1');
      return response;
    }

    // AUTH_SECRET not available — can't forge session, fall through to normal auth
    console.warn('[QA Bypass] AUTH_SECRET not set, bypass token generation failed');
  }

  // Standard Auth.js protection: redirect unauthenticated users to sign-in
  const session = (request as NextRequest & { auth: unknown }).auth;
  const isAuthenticated = !!session;
  const { pathname } = request.nextUrl;

  const isPublicRoute =
    pathname.startsWith('/sign-in') ||
    pathname.startsWith('/api/auth');

  if (!isAuthenticated && !isPublicRoute) {
    const signInUrl = new URL('/sign-in', request.nextUrl.origin);
    signInUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}) as (request: NextRequest) => Promise<NextResponse>;

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
```

### Step 4: Check for jose dependency

Auth.js v5 already depends on `jose` internally, but verify it's available as a direct import:

```bash
cat package.json | grep jose
```

If `jose` is not listed as a direct dependency, add it:

```bash
npm install jose
```

If `jose` IS already available (very likely since next-auth@beta depends on it), no action needed — just verify the import resolves correctly.

### Step 5: Check existing middleware (if any) and reconcile

If `middleware.ts` already existed when you checked in Step 1, **do not blindly overwrite it**. Instead:

1. Read the existing file carefully
2. Check if it already has an `auth()` wrapper or its own matcher config
3. Integrate the bypass logic into the existing structure, preserving any existing route protection logic
4. If the existing middleware already calls `auth()`, just add the `isQABypassRequest` check and `createBypassSessionToken` at the top of the handler

### Step 6: Verify Auth.js export names

Confirm the import `import { auth } from './lib/auth'` is correct:

```bash
grep -E "^export" lib/auth.ts | head -20
```

If `auth` is exported under a different name or from a different path, update the import accordingly. Common patterns in Auth.js v5:
- `export const { auth, handlers, signIn, signOut } = NextAuth(config)`
- `export { auth } from './auth'` re-exports

### Step 7: TypeScript verification

```bash
npx tsc --noEmit
```

If you see errors about `jose` types, the `SignJWT` usage, or the `auth` wrapper type, fix them:

**Common fix 1** — `auth` wrapper type mismatch:
```typescript
// If the cast at the end causes issues, use:
export default auth(async (request) => {
  // ... implementation
});
// Remove the `as (request: NextRequest) => Promise<NextResponse>` cast
```

**Common fix 2** — `request.auth` type:
```typescript
// Add type assertion inline
const session = (request as NextRequest & { auth: { user?: { email?: string } } | null }).auth;
```

**Common fix 3** — async middleware with Auth.js v5:
```typescript
// Auth.js v5 auth() handler may not support async callbacks in all versions
// If needed, use a sync wrapper that calls an async function:
export default auth((request) => {
  if (isQABypassRequest(request)) {
    // Use a sync approach or return a promise
    return handleBypass(request);
  }
  // ... sync path
});

async function handleBypass(request: NextRequest): Promise<NextResponse> {
  const sessionToken = await createBypassSessionToken();
  // ...
}
```

Iterate until `npx tsc --noEmit` passes with zero errors.

### Step 8: Build verification

```bash
npm run build
```

Fix any build errors before proceeding. Edge middleware has stricter constraints than Node.js — ensure no Node.js-only APIs are used (all code in middleware runs in the Vercel Edge runtime).

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add preview auth bypass middleware for QA Agent

Adds middleware.ts with a token-based auth bypass for Vercel Preview
deployments. The bypass activates only when:
  1. VERCEL_ENV === 'preview'
  2. X-QA-Agent-Token header is present
  3. Header value matches QA_BYPASS_SECRET env var

When active, injects a signed Auth.js v5 JWT session cookie for
james.stine.heath@gmail.com so the QA Agent can test authenticated
routes without going through Google OAuth.

No behavior change in production. QA_BYPASS_SECRET must be set as
a Vercel env var scoped to Preview environments only.

Pattern documented in code comments for replication in other repos."

git push origin feat/preview-auth-bypass

gh pr create \
  --title "feat: add preview auth bypass middleware for QA Agent" \
  --body "## Summary

Adds \`middleware.ts\` with a preview-only auth bypass so the QA Agent can test authenticated routes in Vercel Preview deployments.

## Changes
- **\`middleware.ts\`** (new/modified): Auth.js v5 middleware with QA bypass logic

## How It Works

Three conditions must ALL be true for bypass to activate:
1. \`process.env.VERCEL_ENV === 'preview'\`
2. \`X-QA-Agent-Token\` request header is present  
3. Header value matches \`process.env.QA_BYPASS_SECRET\`

When conditions are met, a signed JWT session cookie is injected for \`james.stine.heath@gmail.com\` using \`AUTH_SECRET\` as the signing key — same format Auth.js v5 uses natively.

## Security
- Strictly no-op in production (VERCEL_ENV check)
- QA_BYPASS_SECRET must be set as Vercel env var scoped to Preview only
- Does not bypass production routes under any circumstances

## Manual Prerequisite
Set \`QA_BYPASS_SECRET\` as a Vercel environment variable scoped to **Preview** environments only before testing.

## Testing
QA Agent sends: \`X-QA-Agent-Token: <QA_BYPASS_SECRET>\` header to Preview deployment URL. Protected routes should return 200 instead of redirecting to sign-in."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/preview-auth-bypass
FILES CHANGED: [middleware.ts]
SUMMARY: [what was done]
ISSUES: [what failed - e.g., "Auth.js v5 auth() wrapper doesn't accept async callback in this version", "jose import not resolving"]
NEXT STEPS: [e.g., "Verify AUTH_SECRET env var name matches auth.ts config", "Check if jose needs to be added to package.json directly", "Confirm session cookie name for this Auth.js v5 version"]
```

### Escalation

If you hit an unresolvable blocker (e.g., `lib/auth.ts` uses a session strategy incompatible with JWT cookie injection, or the Auth.js v5 middleware API differs significantly from what's documented here):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "auth-bypass-middleware-preview",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message>",
      "filesChanged": ["middleware.ts"]
    }
  }'
```