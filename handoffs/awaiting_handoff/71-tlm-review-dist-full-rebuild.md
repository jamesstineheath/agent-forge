# Handoff 71: TLM Code Review — Full dist rebuild

## Metadata
- Branch: `fix/tlm-review-dist-full-rebuild`
- Priority: critical
- Model: sonnet
- Type: bugfix
- Max Budget: $3
- Risk Level: medium
- Complexity: simple
- Date: 2026-03-21

## Context

The TLM Code Review GitHub Action at `.github/actions/tlm-review/` has a stale `dist/index.js` bundle. The TypeScript source (`src/index.ts`) was updated in PR #435 with a fix to the `checkCIStatus` function (when zero non-TLM checks are found, poll for 30s instead of returning "passed"), but the dist was never properly rebuilt. PR #448 attempted a rebuild but failed (only 3 lines changed in dist vs 40 in source).

The dist is what GitHub Actions actually executes. The source fix is dead code until the dist is rebuilt.

## Pre-flight Self-Check

- [ ] Run `cat .github/actions/tlm-review/src/index.ts | grep -A5 "ciChecks.length === 0"` and confirm the polling loop exists in source
- [ ] Run `cat .github/actions/tlm-review/dist/index.js | grep "Waiting for CI to register"` and confirm it returns NOTHING (proving dist is stale)
- [ ] Run `cat .github/actions/tlm-review/package.json` to find the exact build command

## Step 0: Branch, commit handoff, push

Create branch `fix/tlm-review-dist-full-rebuild` from `main`. Commit this handoff file. Push.

## Step 1: Install dependencies and rebuild

```bash
cd .github/actions/tlm-review
npm ci
```

Check package.json for the build script. It's likely one of: `npm run build`, `npm run package`, or `npx ncc build src/index.ts -o dist`. Run whatever the build command is.

If there is NO build script in package.json, look for:
- A `tsconfig.json` (use `npx tsc`)
- An `ncc` dependency (use `npx ncc build src/index.ts -o dist`)
- An `esbuild` dependency (use `npx esbuild src/index.ts --bundle --platform=node --outfile=dist/index.js`)

The output MUST produce a single `dist/index.js` file that bundles all dependencies.

## Step 2: Verify the rebuild contains the fix

```bash
grep -c "Waiting for CI to register" dist/index.js
grep -c "No CI checks appeared after" dist/index.js
```

Both must return 1 or more. If either returns 0, the rebuild failed to include the source changes. Debug by checking for TypeScript compilation errors.

## Step 3: Verify from repo root

```bash
cd ../../..
npx tsc --noEmit
```

## Step 4: Commit the rebuilt dist

```bash
git add .github/actions/tlm-review/dist/
git commit -m "fix: full rebuild of TLM Code Review dist bundle

The dist/index.js was stale — source had CI gate fix (poll for checks
instead of assuming passed when empty) but dist was never recompiled.
PR #435 added the source fix, PR #448 attempted rebuild but only
hand-edited 3 lines. This is a proper npm run build."
git push origin fix/tlm-review-dist-full-rebuild
```

Open PR targeting main.

## Session Abort Protocol

If the build fails:
1. Run `cat .github/actions/tlm-review/package.json` and report contents
2. Run `ls .github/actions/tlm-review/` and report directory structure
3. Commit and push whatever state exists
4. Open draft PR with findings
