import { NextResponse } from "next/server";
import { loadJson, saveJson } from "@/lib/storage";

/**
 * Temporary endpoint to test storage module read/write cycle.
 * DELETE AFTER DEBUGGING.
 *
 * GET /api/debug/blob-test — write, read back, then read repos/index
 */
export async function GET() {
  const results: Record<string, unknown> = {};

  results["env_BLOB_READ_WRITE_TOKEN"] = process.env.BLOB_READ_WRITE_TOKEN
    ? "set"
    : "MISSING";

  // Test 1: Write then read via storage module
  try {
    const testKey = "_debug/roundtrip";
    const testValue = { ok: true, ts: Date.now() };
    await saveJson(testKey, testValue);
    const readBack = await loadJson(testKey);
    results["test1_roundtrip"] = {
      success: JSON.stringify(readBack) === JSON.stringify(testValue),
      wrote: testValue,
      readBack,
    };
  } catch (err) {
    results["test1_roundtrip"] = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Test 2: Read repos/index (the one that's been failing)
  try {
    const reposIndex = await loadJson("repos/index");
    results["test2_repos_index"] = {
      success: true,
      value: reposIndex,
      isNull: reposIndex === null,
    };
  } catch (err) {
    results["test2_repos_index"] = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Test 3: Direct Blob operations for comparison
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { head, getDownloadUrl } = await import("@vercel/blob");
      const blob = await head("af-data/repos/index.json");
      results["test3_head"] = { url: blob.url, size: blob.size };

      const downloadUrl = await getDownloadUrl(blob.url);
      results["test3_downloadUrl"] = downloadUrl.slice(0, 80) + "...";

      const response = await fetch(downloadUrl, { cache: "no-store" });
      const text = await response.text();
      results["test3_fetch"] = {
        ok: response.ok,
        status: response.status,
        body: text.slice(0, 300),
      };
    } catch (err) {
      results["test3_direct_blob"] = {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return NextResponse.json(results, { status: 200 });
}
