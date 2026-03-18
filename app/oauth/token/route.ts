import { NextRequest, NextResponse } from "next/server";
import { issueToken, exchangeAuthCode } from "@/lib/oauth";

export async function POST(request: NextRequest) {
  let body: Record<string, string>;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await request.formData();
    body = Object.fromEntries(formData.entries()) as Record<string, string>;
  } else {
    body = (await request.json()) as Record<string, string>;
  }

  const { grant_type, client_id, client_secret, code, redirect_uri, code_verifier } = body;

  if (grant_type === "client_credentials") {
    if (!client_id || !client_secret) {
      return NextResponse.json(
        { error: "invalid_request", error_description: "client_id and client_secret are required" },
        { status: 400 }
      );
    }

    const tokenResponse = issueToken(client_id, client_secret);
    if (!tokenResponse) {
      return NextResponse.json(
        { error: "invalid_client", error_description: "Invalid client credentials" },
        { status: 401 }
      );
    }

    return NextResponse.json(tokenResponse, {
      headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
    });
  }

  if (grant_type === "authorization_code") {
    if (!code || !client_id || !redirect_uri) {
      return NextResponse.json(
        { error: "invalid_request", error_description: "code, client_id, and redirect_uri are required" },
        { status: 400 }
      );
    }

    const tokenResponse = exchangeAuthCode(code, client_id, redirect_uri, code_verifier);
    if (!tokenResponse) {
      return NextResponse.json(
        { error: "invalid_grant", error_description: "Invalid or expired authorization code" },
        { status: 400 }
      );
    }

    return NextResponse.json(tokenResponse, {
      headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
    });
  }

  return NextResponse.json(
    { error: "unsupported_grant_type", error_description: "Supported: authorization_code, client_credentials" },
    { status: 400 }
  );
}
