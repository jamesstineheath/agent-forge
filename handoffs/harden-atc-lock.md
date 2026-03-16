# Handoff: Harden ATC cycle lock with timeout and force-clear

**Priority:** P1
**Max Budget:** $3
**Branch:** fix/atc-lock-hardening

## Problem

`_runATCCycleInner()` is a massive function (~13 sections). When Vercel kills the serverless function on its 60s timeout, the `finally` block never runs, leaving the ATC lock stuck. If each subsequent cycle also times out, it refreshes the lock timestamp and the pattern repeats — creating a zombie lock that blocks all future ATC cycles.

## Pre-flight Self-check

- [ ] Read `lib/atc.ts` fully — confirm `acquireATCLock`, `releaseATCLock`, `runATCCycle`, and `_runATCCycleInner` exist
- [ ] Confirm `LOCK_TTL_MS` constant exists
- [ ] Confirm `loadJson`, `saveJson`, `deleteJson`, and `ATC_LOCK_KEY` are available
- [ ] Run `npx tsc --noEmit` to verify clean baseline

## Step 0: Branch + Commit Setup

```
git checkout main && git pull origin main
git checkout -b fix/atc-lock-hardening
```

## Step 1: Add new constants

In `lib/atc.ts`, add two constants immediately after `LOCK_TTL_MS`:

```typescript
const LOCK_HARD_CEILING_MS = 10 * 60 * 1000; // 10 minutes — force-clear zombie locks
const CYCLE_TIMEOUT_MS = 55 * 1000; // 55s — abort before Vercel's 60s kill
```

## Step 2: Replace `acquireATCLock`

Replace with:

```typescript
export async function acquireATCLock(): Promise<boolean> {
  const existing = await loadJson<{ acquiredAt: string; id: string }>(ATC_LOCK_KEY);

  if (existing) {
    const age = Date.now() - new Date(existing.acquiredAt).getTime();

    if (age >= LOCK_HARD_CEILING_MS) {
      console.warn(
        `[atc] Lock exceeded hard ceiling (age: ${Math.round(age / 1000)}s). Force-clearing.`,
      );
      await deleteJson(ATC_LOCK_KEY);
    } else if (age < LOCK_TTL_MS) {
      console.log(`[atc] Cycle lock held (age: ${Math.round(age / 1000)}s). Skipping.`);
      return false;
    } else {
      console.log(`[atc] Expired lock found (age: ${Math.round(age / 1000)}s). Clearing before re-acquire.`);
      await deleteJson(ATC_LOCK_KEY);
    }
  }

  const lockId = randomUUID();
  await saveJson(ATC_LOCK_KEY, { acquiredAt: new Date().toISOString(), id: lockId });
  const reread = await loadJson<{ id: string }>(ATC_LOCK_KEY);
  return reread?.id === lockId;
}
```

## Step 3: Add timeout utility and replace `runATCCycle`

Add above `runATCCycle`:

```typescript
class CycleTimeoutError extends Error {
  constructor(ms: number) {
    super(`ATC cycle timed out after ${ms}ms`);
    this.name = 'CycleTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CycleTimeoutError(ms)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
```

Replace `runATCCycle`:

```typescript
export async function runATCCycle(): Promise<ATCState> {
  const locked = await acquireATCLock();
  if (!locked) {
    return await getATCState();
  }

  try {
    return await withTimeout(_runATCCycleInner(), CYCLE_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof CycleTimeoutError) {
      console.error(`[atc] Cycle aborted after ${CYCLE_TIMEOUT_MS / 1000}s timeout.`);
      return await getATCState();
    }
    throw err;
  } finally {
    await releaseATCLock();
  }
}
```

## Step 4: Verification

- `npx tsc --noEmit` must pass
- `npm run build` must succeed
- `_runATCCycleInner` is NOT modified

## Abort Protocol

If `lib/atc.ts` structure differs significantly from described, stop and report.

## Acceptance Criteria

1. Three-tier lock age check (active/expired/zombie) in `acquireATCLock`
2. 55s timeout wrapper around `_runATCCycleInner` in `runATCCycle`
3. Lock always released in `finally`
4. `_runATCCycleInner` unchanged
5. TypeScript and build pass
