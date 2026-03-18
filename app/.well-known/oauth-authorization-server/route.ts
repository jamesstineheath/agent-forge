import { NextResponse } from "next/server";

export async function GET() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://agent-forge-phi.vercel.app";

  return NextResponse.json({
    issuer: baseUrl,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    grant_types_supported: ["client_credentials"],
    response_types_supported: ["token"],
    scopes_supported: ["mcp:tools"],
    service_documentation: `${baseUrl}`,
  });
}
