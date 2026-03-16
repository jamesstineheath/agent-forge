import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { join, dirname } from "path";

const DATA_DIR = join(process.cwd(), "data");

// Write-through cache: Vercel Blob CDN has a minimum 60s cache TTL, so
// sequential tool calls within the same serverless invocation would read
// stale data. This module-level Map caches the last-written value per key,
// giving instant read-after-write consistency within the same request.
// Entries expire after 120s to avoid serving permanently stale data.
const writeCache = new Map<string, { data: string; ts: number }>();
const WRITE_CACHE_TTL_MS = 120_000;

/**
 * Load a JSON value by key.
 * Uses Vercel Blob in production, local files in development.
 */
export async function loadJson<T>(key: string, options?: { required?: boolean }): Promise<T | null> {
  const cached = writeCache.get(key);
  if (cached && Date.now() - cached.ts < WRITE_CACHE_TTL_MS) {
    return JSON.parse(cached.data) as T;
  }
  writeCache.delete(key);

  try {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      return await loadFromBlob<T>(key);
    }
    return await loadFromFile<T>(key);
  } catch (err) {
    console.error(`[storage] loadJson failed for key "${key}":`, err);
    if (options?.required) {
      throw new Error(`Required blob "${key}" failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}

/**
 * Save a JSON value by key.
 * Uses Vercel Blob in production, local files in development.
 */
export async function saveJson<T>(key: string, data: T): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    await saveToBlob(key, json);
  } else {
    await saveToFile(key, json);
  }
  writeCache.set(key, { data: json, ts: Date.now() });
}

/**
 * Delete a JSON value by key.
 */
export async function deleteJson(key: string): Promise<void> {
  writeCache.delete(key);
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    return deleteFromBlob(key);
  }
  return deleteFromFile(key);
}

// --- Vercel Blob ---

async function loadFromBlob<T>(key: string): Promise<T | null> {
  const pathname = `af-data/${key}.json`;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;

  const { head } = await import("@vercel/blob");
  let blob;
  try {
    blob = await head(pathname, { token });
  } catch {
    // Blob not found (404) — this is expected for missing keys
    return null;
  }
  // Private stores require Authorization header for direct URL access
  const response = await fetch(blob.url, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  return (await response.json()) as T;
}

async function saveToBlob(key: string, json: string): Promise<void> {
  const { put } = await import("@vercel/blob");
  const pathname = `af-data/${key}.json`;
  await put(pathname, json, {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
  });
}

async function deleteFromBlob(key: string): Promise<void> {
  const { del } = await import("@vercel/blob");
  const pathname = `af-data/${key}.json`;
  await del(pathname);
}

// --- Local file fallback ---

async function loadFromFile<T>(key: string): Promise<T | null> {
  try {
    const content = await readFile(join(DATA_DIR, `${key}.json`), "utf-8");
    const trimmed = content.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

async function saveToFile(key: string, json: string): Promise<void> {
  const filePath = join(DATA_DIR, `${key}.json`);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, json + "\n");
}

async function deleteFromFile(key: string): Promise<void> {
  try {
    await unlink(join(DATA_DIR, `${key}.json`));
  } catch {
    // File doesn't exist, that's fine
  }
}
