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
