# Handoff 09: ATC Branch Cleanup

**Target repo:** `jamesstineheath/agent-forge`
**Complexity:** Simple (3 files)
**Risk:** Low
**Max Budget:** $3
**Estimated files:** `lib/github.ts`, `lib/atc.ts`, `lib/types.ts`

## Pre-flight self-check

Before executing, confirm:
- [ ] You are on a fresh branch from `main`
- [ ] `lib/github.ts` exists and contains `ghFetch` and `getPRByBranch`
- [ ] `lib/atc.ts` exists and contains `runATCCycle`
- [ ] `lib/types.ts` exists and contains `ATCEvent` type
- [ ] No open PRs touch `lib/github.ts`, `lib/atc.ts`, or `lib/types.ts`

## Step 0: Branch, commit handoff, push
