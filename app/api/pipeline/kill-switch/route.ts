import { NextRequest, NextResponse } from "next/server";
import { getKillSwitchState, setKillSwitch } from "@/lib/atc/kill-switch";

export async function GET() {
  const state = await getKillSwitchState();
  return NextResponse.json(state);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { enabled, pin } = body;

  if (typeof enabled !== "boolean") {
    return NextResponse.json(
      { error: "Missing or invalid 'enabled' boolean field" },
      { status: 400 }
    );
  }

  const expectedPin = process.env.KILL_SWITCH_PIN;
  if (!expectedPin || pin !== expectedPin) {
    return NextResponse.json(
      { error: "Invalid PIN" },
      { status: 403 }
    );
  }

  const state = await setKillSwitch(enabled, "ui");
  console.log(
    `[kill-switch] Pipeline ${enabled ? "STOPPED" : "STARTED"} at ${state.toggledAt}`
  );
  return NextResponse.json(state);
}
