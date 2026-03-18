import { NextRequest, NextResponse } from "next/server";
import { storeAuthCode } from "@/lib/oauth";

/**
 * OAuth Authorization endpoint.
 * Single-user system — auto-approves and redirects with an auth code.
 * Supports PKCE (code_challenge / code_challenge_method).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const responseType = searchParams.get("response_type");
  const clientId = searchParams.get("client_id");
  const redirectUri = searchParams.get("redirect_uri");
  const state = searchParams.get("state");
  const codeChallenge = searchParams.get("code_challenge");
  const codeChallengeMethod = searchParams.get("code_challenge_method");

  if (responseType !== "code") {
    return NextResponse.json(
      { error: "unsupported_response_type" },
      { status: 400 }
    );
  }

  if (!clientId || !redirectUri) {
    return NextResponse.json(
      { error: "invalid_request", error_description: "client_id and redirect_uri are required" },
      { status: 400 }
    );
  }

  // Generate authorization code and store with PKCE challenge
  const code = storeAuthCode(clientId, redirectUri, codeChallenge, codeChallengeMethod);

  // Auto-approve: redirect back immediately with the code
  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);

  return NextResponse.redirect(redirectUrl.toString());
}
