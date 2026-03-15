import { NextResponse } from "next/server";

/**
 * Temporary endpoint to test Vercel Blob operations directly.
 * DELETE AFTER DEBUGGING.
 *
 * GET /api/debug/blob-test — run put/head/list/get cycle
 */
export async function GET() {
  const results: Record<string, unknown> = {};

  // Step 0: Check env
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  results["env_BLOB_READ_WRITE_TOKEN"] = token
    ? `set (${token.slice(0, 20)}...${token.slice(-4)})`
    : "MISSING";

  if (!token) {
    return NextResponse.json(results, { status: 200 });
  }

  // Step 1: Try put
  try {
    const { put } = await import("@vercel/blob");
    const testData = JSON.stringify({ test: true, ts: Date.now() });
    const blob = await put("af-data/_debug_test.json", testData, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    results["step1_put_public"] = { success: true, url: blob.url, pathname: blob.pathname };
  } catch (err) {
    results["step1_put_public"] = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
    };
  }

  // Step 1b: Try put with private access (matching production config)
  try {
    const { put } = await import("@vercel/blob");
    const testData = JSON.stringify({ test: true, ts: Date.now(), access: "private" });
    const blob = await put("af-data/_debug_test_private.json", testData, {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    results["step1b_put_private"] = { success: true, url: blob.url, pathname: blob.pathname };
  } catch (err) {
    results["step1b_put_private"] = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
    };
  }

  // Step 2: Try head on what we just wrote
  try {
    const { head } = await import("@vercel/blob");
    const blob = await head("af-data/_debug_test.json");
    results["step2_head"] = { success: true, url: blob.url, size: blob.size };
  } catch (err) {
    results["step2_head"] = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
    };
  }

  // Step 3: Try list to see what's in the store
  try {
    const { list } = await import("@vercel/blob");
    const { blobs } = await list({ prefix: "af-data/", limit: 20 });
    results["step3_list"] = {
      success: true,
      count: blobs.length,
      blobs: blobs.map((b) => ({
        pathname: b.pathname,
        size: b.size,
        uploadedAt: b.uploadedAt,
      })),
    };
  } catch (err) {
    results["step3_list"] = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
    };
  }

  // Step 4: Try fetching the blob content
  try {
    const { head } = await import("@vercel/blob");
    const blob = await head("af-data/_debug_test.json");
    const response = await fetch(blob.url, { cache: "no-store" });
    const text = await response.text();
    results["step4_fetch_content"] = {
      success: response.ok,
      status: response.status,
      body: text.slice(0, 200),
    };
  } catch (err) {
    results["step4_fetch_content"] = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Step 5: Check what the storage module sees for repos/index
  try {
    const { loadJson } = await import("@/lib/storage");
    const index = await loadJson("repos/index");
    results["step5_storage_loadJson_repos_index"] = {
      success: true,
      value: index,
    };
  } catch (err) {
    results["step5_storage_loadJson_repos_index"] = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Step 6: Try direct Blob head for the repos index
  try {
    const { head } = await import("@vercel/blob");
    const blob = await head("af-data/repos/index.json");
    results["step6_direct_head_repos_index"] = {
      success: true,
      url: blob.url,
      size: blob.size,
    };
  } catch (err) {
    results["step6_direct_head_repos_index"] = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
    };
  }

  return NextResponse.json(results, { status: 200 });
}
