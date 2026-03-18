import { NextRequest, NextResponse } from "next/server";
import { registerClient } from "@/lib/oauth";

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    client_name?: string;
    grant_types?: string[];
    token_endpoint_auth_method?: string;
  };

  const clientName = body.client_name ?? "unknown";

  const result = registerClient(clientName);

  return NextResponse.json(
    {
      client_id: result.client_id,
      client_secret: result.client_secret,
      client_name: result.client_name,
      grant_types: ["client_credentials"],
      token_endpoint_auth_method: "client_secret_post",
    },
    { status: 201 }
  );
}
