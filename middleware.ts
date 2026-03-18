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
  const session = (request as NextRequest & { auth: { user?: { email?: string } } | null }).auth;
  const isAuthenticated = !!session;
  const { pathname } = request.nextUrl;

  const isPublicRoute =
    pathname.startsWith('/sign-in') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/.well-known/') ||
    pathname.startsWith('/oauth/');

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
