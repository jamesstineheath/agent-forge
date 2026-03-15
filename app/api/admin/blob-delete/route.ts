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

/**
 * DELETE /api/admin/blob-delete?key=atc/project-decomposed/PRJ-6
 *
 * Deletes a blob key from the store. Useful for clearing dedup guards,
 * stale keys, and other operational cleanup.
 *
 * Query params:
 *   key: The storage key (without .json extension)
 *   dry_run: If "true", checks if key exists without deleting
 */
export async function DELETE(request: NextRequest) {
  if (!isAuthorized(request)) {
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

  const dryRun = request.nextUrl.searchParams.get("dry_run") === "true";

  // Check if key exists
  const existing = await loadJson(key);

  if (dryRun) {
    return NextResponse.json({
      key,
      exists: existing !== null,
      dry_run: true,
      value: existing,
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
