import { NextResponse } from "next/server";
import { loadJson, saveJson } from "@/lib/storage";

/**
 * Temporary endpoint to test storage reads with explicit token.
 * DELETE AFTER DEBUGGING.
 */
export async function GET() {
  const results: Record<string, unknown> = {};
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  results["env_BLOB_READ_WRITE_TOKEN"] = token ? "set" : "MISSING";

  // Test 1: Write + read (cache hit, should always work)
  try {
    const testValue = { ok: true, ts: Date.now() };
    await saveJson("_debug/roundtrip", testValue);
    const readBack = await loadJson("_debug/roundtrip");
    results["test1_roundtrip"] = {
      success: JSON.stringify(readBack) === JSON.stringify(testValue),
      wrote: testValue,
      readBack,
    };
  } catch (err) {
    results["test1_roundtrip"] = { success: false, error: String(err) };
  }

  // Test 2: Read repos/index via storage module (tests loadFromBlob fix)
  try {
    const reposIndex = await loadJson("repos/index");
    results["test2_repos_index"] = {
      value: reposIndex,
      isNull: reposIndex === null,
    };
  } catch (err) {
    results["test2_repos_index"] = { error: String(err) };
  }

  // Test 3: Direct head + getDownloadUrl with explicit token
  if (token) {
    try {
      const { head, getDownloadUrl } = await import("@vercel/blob");
      const blob = await head("af-data/repos/index.json", { token });
      results["test3_head"] = { url: blob.url, size: blob.size };

      const downloadUrl = await getDownloadUrl(blob.url, { token });
      results["test3_downloadUrl"] = downloadUrl.slice(0, 80) + "...";

      const response = await fetch(downloadUrl, { cache: "no-store" });
      const text = await response.text();
      results["test3_fetch"] = {
        ok: response.ok,
        status: response.status,
        body: text.slice(0, 300),
      };
    } catch (err) {
      results["test3_error"] = err instanceof Error ? err.message : String(err);
    }
  }

  return NextResponse.json(results);
}
