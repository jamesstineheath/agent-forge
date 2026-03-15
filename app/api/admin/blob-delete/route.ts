import { NextRequest, NextResponse } from "next/server";
import { deleteJson, loadJson } from "@/lib/storage";

function isAuthorized(request: NextRequest): boolean {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  return (
    token === process.env.AGENT_FORGE_API_SECRET ||
    token === process.env.ESCALATION_SECRET
  );
}

function getSecretFromQuery(request: NextRequest): boolean {
  const secret = request.nextUrl.searchParams.get("secret");
  if (!secret) return false;
  return (
    secret === process.env.AGENT_FORGE_API_SECRET ||
    secret === process.env.ESCALATION_SECRET
  );
}

async function handleBlobDelete(request: NextRequest) {
  // Support both Bearer token and query param auth
  if (!isAuthorized(request) && !getSecretFromQuery(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const key = request.nextUrl.searchParams.get("key");
  if (!key) {
    return NextResponse.json(
      { error: "Missing required query parameter: key" },
      { status: 400 }
    );
  }

  // Safety: prevent deleting core data keys
  const PROTECTED_PREFIXES = ["work-items/", "repos/", "work-item-index"];
  if (PROTECTED_PREFIXES.some((p) => key.startsWith(p))) {
    return NextResponse.json(
      { error: `Key '${key}' is protected and cannot be deleted via this endpoint` },
      { status: 403 }
    );
  }

  const action = request.nextUrl.searchParams.get("action");
  const dryRun = action !== "delete";

  // Check if key exists
  const existing = await loadJson(key);

  if (dryRun) {
    return NextResponse.json({
      key,
      exists: existing !== null,
      dry_run: true,
      value: existing,
      hint: "Add action=delete to actually delete the key",
    });
  }

  if (existing === null) {
    return NextResponse.json({
      key,
      deleted: false,
      message: "Key does not exist",
    });
  }

  await deleteJson(key);

  return NextResponse.json({
    key,
    deleted: true,
    previous_value: existing,
  });
}

export async function GET(request: NextRequest) {
  return handleBlobDelete(request);
}

export async function DELETE(request: NextRequest) {
  return handleBlobDelete(request);
}
