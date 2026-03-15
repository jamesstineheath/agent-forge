import { NextResponse } from "next/server";

/**
 * Temporary endpoint to test Vercel Blob read approaches.
 * DELETE AFTER DEBUGGING.
 *
 * GET /api/debug/blob-test
 */
export async function GET() {
  const results: Record<string, unknown> = {};

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  results["env_BLOB_READ_WRITE_TOKEN"] = token
    ? `set (${token.slice(0, 20)}...)`
    : "MISSING";

  if (!token) {
    return NextResponse.json(results, { status: 200 });
  }

  // We know repos/index.json exists (544 bytes). Test every read approach.
  const testPathname = "af-data/repos/index.json";

  // Approach 1: head() — get metadata
  let headUrl = "";
  try {
    const { head } = await import("@vercel/blob");
    const blob = await head(testPathname);
    // Log ALL properties
    headUrl = blob.url;
    results["approach1_head"] = {
      success: true,
      url: blob.url,
      downloadUrl: (blob as Record<string, unknown>).downloadUrl ?? "NOT_PRESENT",
      pathname: blob.pathname,
      size: blob.size,
      allKeys: Object.keys(blob),
    };
  } catch (err) {
    results["approach1_head"] = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Approach 2: fetch blob.url directly (expected to fail for private)
  if (headUrl) {
    try {
      const response = await fetch(headUrl, { cache: "no-store" });
      const text = await response.text();
      results["approach2_fetch_url"] = {
        success: response.ok,
        status: response.status,
        statusText: response.statusText,
        bodyPreview: text.slice(0, 200),
      };
    } catch (err) {
      results["approach2_fetch_url"] = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Approach 3: getDownloadUrl then fetch
  try {
    const { getDownloadUrl } = await import("@vercel/blob");
    const downloadResult = await getDownloadUrl(headUrl);
    results["approach3_getDownloadUrl"] = {
      success: true,
      resultType: typeof downloadResult,
      result: typeof downloadResult === "string"
        ? downloadResult.slice(0, 100)
        : JSON.stringify(downloadResult).slice(0, 200),
    };
    const fetchUrl = typeof downloadResult === "string" ? downloadResult : (downloadResult as Record<string, unknown>).url;
    if (fetchUrl) {
      const response = await fetch(String(fetchUrl), { cache: "no-store" });
      const text = await response.text();
      results["approach3_fetch_result"] = {
        success: response.ok,
        status: response.status,
        bodyPreview: text.slice(0, 200),
      };
    }
  } catch (err) {
    results["approach3_getDownloadUrl"] = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 3) : undefined,
    };
  }

  // Approach 4: get() function
  try {
    const { get } = await import("@vercel/blob");
    const blob = await get(testPathname);
    results["approach4_get"] = {
      success: true,
      resultType: typeof blob,
      allKeys: blob ? Object.keys(blob) : [],
      hasBody: !!(blob as Record<string, unknown>)?.body,
      bodyType: typeof (blob as Record<string, unknown>)?.body,
    };
    // Try to read body if it's a Response-like object
    if (blob && typeof (blob as Record<string, unknown>).text === "function") {
      const text = await (blob as Response).text();
      results["approach4_get_body"] = text.slice(0, 200);
    } else if (blob && typeof (blob as Record<string, unknown>).body === "string") {
      results["approach4_get_body"] = String((blob as Record<string, unknown>).body).slice(0, 200);
    }
  } catch (err) {
    results["approach4_get"] = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
    };
  }

  // Approach 5: fetch with Authorization header
  if (headUrl) {
    try {
      const response = await fetch(headUrl, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await response.text();
      results["approach5_fetch_with_auth"] = {
        success: response.ok,
        status: response.status,
        bodyPreview: text.slice(0, 200),
      };
    } catch (err) {
      results["approach5_fetch_with_auth"] = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return NextResponse.json(results, { status: 200 });
}
