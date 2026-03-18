import { randomUUID } from "crypto";
import { loadJson, saveJson, deleteJson } from "../storage";
import { LOCK_TTL_MS, LOCK_HARD_CEILING_MS } from "./types";

/**
 * Optimistic distributed lock using Vercel Blob.
 * Not a true atomic CAS (Blob doesn't support it), but sufficient given
 * the cron interval is measured in minutes. The write-then-reread
 * pattern catches most races.
 */
export async function acquireLock(lockKey: string): Promise<boolean> {
  const existing = await loadJson<{ acquiredAt: string; id: string }>(lockKey);

  if (existing) {
    const age = Date.now() - new Date(existing.acquiredAt).getTime();

    if (age >= LOCK_HARD_CEILING_MS) {
      console.warn(
        `[lock] Lock ${lockKey} exceeded hard ceiling (age: ${Math.round(age / 1000)}s). Force-clearing.`
      );
      await deleteJson(lockKey);
    } else if (age < LOCK_TTL_MS) {
      console.log(
        `[lock] Lock ${lockKey} held (age: ${Math.round(age / 1000)}s). Skipping.`
      );
      return false;
    } else {
      console.log(
        `[lock] Expired lock ${lockKey} found (age: ${Math.round(age / 1000)}s). Clearing before re-acquire.`
      );
      await deleteJson(lockKey);
    }
  }

  const lockId = randomUUID();
  await saveJson(lockKey, {
    acquiredAt: new Date().toISOString(),
    id: lockId,
  });
  const reread = await loadJson<{ id: string }>(lockKey);
  return reread?.id === lockId;
}

export async function releaseLock(lockKey: string): Promise<void> {
  await deleteJson(lockKey);
}

// Legacy ATC lock key
const ATC_LOCK_KEY = "atc/cycle-lock";

export async function acquireATCLock(): Promise<boolean> {
  return acquireLock(ATC_LOCK_KEY);
}

export async function releaseATCLock(): Promise<void> {
  return releaseLock(ATC_LOCK_KEY);
}
