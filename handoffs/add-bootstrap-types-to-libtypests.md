# Agent Forge -- Add Bootstrap Types to lib/types.ts

## Metadata
- **Branch:** `feat/add-bootstrap-types`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/types.ts

## Context

Agent Forge is a dev orchestration platform (Next.js on Vercel) that coordinates autonomous agent teams across multiple repositories. The platform is adding a Repo Bootstrapper feature that automates creation and registration of new target repositories.

This task adds the foundational TypeScript type definitions that the Repo Bootstrapper components will depend on. The types live in `lib/types.ts`, which is the centralized type definition file for the project.

The change is purely additive — no existing types are modified, only new exports are added to the end of the file.

## Requirements

1. `lib/types.ts` exports `PipelineLevel` as a union type: `'execute-only' | 'full-tlm'`
2. `lib/types.ts` exports `BootstrapOptions` interface with fields: `repoName: string`, `description?: string`, `pipelineLevel: PipelineLevel`, `isPrivate?: boolean`, `createVercelProject?: boolean`, `vercelFramework?: string`
3. `lib/types.ts` exports `BootstrapStep` interface with fields: `name: string`, `status: 'success' | 'failed' | 'skipped'`, `detail?: string`
4. `lib/types.ts` exports `BootstrapResult` interface with fields: `repoUrl: string`, `repoId: number`, `registrationId: string`, `vercelProjectUrl?: string`, `steps: BootstrapStep[]`
5. The project compiles successfully with no TypeScript errors after the change (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/add-bootstrap-types
```

### Step 1: Inspect the existing lib/types.ts

```bash
cat lib/types.ts
```

Review the existing contents to understand the current structure and ensure the new types are appended without conflicting with any existing definitions.

### Step 2: Append bootstrap types to lib/types.ts

Add the following block to the **end** of `lib/types.ts`. Do not modify any existing content — only append:

```typescript
// Repo Bootstrapper types

export type PipelineLevel = 'execute-only' | 'full-tlm';

export interface BootstrapOptions {
  repoName: string;
  description?: string;
  pipelineLevel: PipelineLevel;
  isPrivate?: boolean;
  createVercelProject?: boolean;
  vercelFramework?: string;
}

export interface BootstrapStep {
  name: string;
  status: 'success' | 'failed' | 'skipped';
  detail?: string;
}

export interface BootstrapResult {
  repoUrl: string;
  repoId: number;
  registrationId: string;
  vercelProjectUrl?: string;
  steps: BootstrapStep[];
}
```

### Step 3: Verification

```bash
npx tsc --noEmit
```

Confirm there are zero TypeScript errors. If `lib/types.ts` did not previously exist, create it with just the bootstrap types block above (no imports needed — these are pure type definitions).

Also do a quick sanity check that all four exports are present:

```bash
grep -E "export (type|interface) (PipelineLevel|BootstrapOptions|BootstrapStep|BootstrapResult)" lib/types.ts
```

Expected output (order may vary):
```
export type PipelineLevel = 'execute-only' | 'full-tlm';
export interface BootstrapOptions {
export interface BootstrapStep {
export interface BootstrapResult {
```

### Step 4: Commit, push, open PR

```bash
git add lib/types.ts
git commit -m "feat: add bootstrap types to lib/types.ts"
git push origin feat/add-bootstrap-types
gh pr create \
  --title "feat: add bootstrap types to lib/types.ts" \
  --body "## Summary

Adds foundational TypeScript type definitions required by the Repo Bootstrapper feature.

### New exports in \`lib/types.ts\`

- \`PipelineLevel\` — union type \`'execute-only' | 'full-tlm'\`
- \`BootstrapOptions\` — input options for bootstrapping a new repo
- \`BootstrapStep\` — result of an individual bootstrap step
- \`BootstrapResult\` — overall result of a bootstrap run

### Notes

- Purely additive change; no existing types modified
- No runtime code changes; types are erased at compile time
- All downstream bootstrapper components can now import from \`lib/types\`

## Acceptance Criteria
- [x] \`PipelineLevel\` exported with correct union values
- [x] \`BootstrapOptions\` exported with all specified fields
- [x] \`BootstrapStep\` exported with correct status union
- [x] \`BootstrapResult\` exported with all specified fields
- [x] \`npx tsc --noEmit\` passes with zero errors"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/add-bootstrap-types
FILES CHANGED: lib/types.ts
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```