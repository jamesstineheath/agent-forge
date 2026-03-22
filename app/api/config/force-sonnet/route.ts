import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { loadJson, saveJson } from "@/lib/storage";

const CONFIG_KEY = "config/force-sonnet";

interface ForceSonnetConfig {
  enabled: boolean;
  activatedAt: string | null;
  activatedBy: string | null;
}

const DEFAULT_CONFIG: ForceSonnetConfig = {
  enabled: false,
  activatedAt: null,
  activatedBy: null,
};

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "CRON_SECRET");
  if (authError) return authError;

  const config = await loadJson<ForceSonnetConfig>(CONFIG_KEY);
  return NextResponse.json(config ?? DEFAULT_CONFIG);
}

export async function POST(req: NextRequest) {
  const authError = await validateAuth(req, "CRON_SECRET");
  if (authError) return authError;

  let body: { enabled: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "`enabled` must be a boolean" },
      { status: 400 }
    );
  }

  const config: ForceSonnetConfig = {
    enabled: body.enabled,
    activatedAt: new Date().toISOString(),
    activatedBy: "operator",
  };

  await saveJson(CONFIG_KEY, config);
  return NextResponse.json(config);
}
