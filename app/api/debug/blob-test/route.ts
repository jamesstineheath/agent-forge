import { NextResponse } from "next/server";

/**
 * Temporary endpoint to test every possible way to read a private blob.
 * DELETE AFTER DEBUGGING.
 */
export async function GET() {
  const results: Record<string, unknown> = {};
  const token = process.env.BLOB_READ_WRITE_TOKEN!;
  const pathname = "af-data/repos/index.json";

  // 1. head() to get URL
  let blobUrl = "";
  try {
    const { head } = await import("@vercel/blob");
    const blob = await head(pathname, { token });
    blobUrl = blob.url;
    results["step1_head"] = { ok: true, url: blob.url, size: blob.size };
  } catch (err) {
    results["step1_head"] = { ok: false, error: String(err) };
    return NextResponse.json(results);
  }

  // 2. get(pathname) with token
  try {
    const { get } = await import("@vercel/blob");
    const resp = await get(pathname, { token });
    const text = await resp.text();
    results["step2_get_pathname"] = { ok: true, status: resp.status, body: text.slice(0, 200) };
  } catch (err) {
    results["step2_get_pathname"] = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // 3. get(blobUrl) with token
  try {
    const { get } = await import("@vercel/blob");
    const resp = await get(blobUrl, { token });
    const text = await resp.text();
    results["step3_get_url"] = { ok: true, status: resp.status, body: text.slice(0, 200) };
  } catch (err) {
    results["step3_get_url"] = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // 4. getDownloadUrl with token
  try {
    const { getDownloadUrl } = await import("@vercel/blob");
    const url = await getDownloadUrl(blobUrl, { token });
    results["step4_downloadUrl"] = { ok: true, url: url.slice(0, 100) };
    const resp = await fetch(url, { cache: "no-store" });
    const text = await resp.text();
    results["step4_fetch"] = { ok: resp.ok, status: resp.status, body: text.slice(0, 200) };
  } catch (err) {
    results["step4_downloadUrl"] = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // 5. fetch blobUrl with x-vercel-blob-rw-token header
  try {
    const resp = await fetch(blobUrl, {
      cache: "no-store",
      headers: { "x-vercel-blob-rw-token": token },
    });
    const text = await resp.text();
    results["step5_fetch_rw_header"] = { ok: resp.ok, status: resp.status, body: text.slice(0, 200) };
  } catch (err) {
    results["step5_fetch_rw_header"] = { ok: false, error: String(err) };
  }

  // 6. fetch blobUrl with Authorization Bearer
  try {
    const resp = await fetch(blobUrl, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await resp.text();
    results["step6_fetch_bearer"] = { ok: resp.ok, status: resp.status, body: text.slice(0, 200) };
  } catch (err) {
    results["step6_fetch_bearer"] = { ok: false, error: String(err) };
  }

  return NextResponse.json(results);
}
