# Agent Forge -- Bootstrapper Core Library (lib/bootstrapper.ts)

## Metadata
- **Branch:** `feat/bootstrapper-core-library`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/bootstrapper.ts, package.json, lib/github.ts

## Context

Agent Forge is a dev orchestration platform that coordinates autonomous agent teams across repositories. A key capability being built is "bootstrapping" new target repositories — setting them up with the full pipeline infrastructure automatically.

This task implements the core `bootstrapRepo` function in `lib/bootstrapper.ts`. The types (`BootstrapOptions`, `BootstrapResult`, `BootstrapStep`) already exist in `lib/types.ts`. The template files helper `getTemplateFiles()` already exists in `lib/templates.ts`. The GitHub API wrapper `lib/github.ts` exists and should be extended as needed. The repo registration logic exists in `lib/repos.ts`.

The bootstrapper orchestrates 5 steps:
1. Create GitHub repo via API
2. Push pipeline workflow files from templates
3. Set repo secrets (encrypted via libsodium-wrappers)
4. Register repo in Blob store
5. Enable GitHub Actions permissions

Key patterns from the codebase:
- `lib/github.ts` wraps GitHub API calls — add new methods there rather than calling GitHub API directly
- `lib/repos.ts` has registration logic already used elsewhere
- Step tracking must use `BootstrapStep` shape with `status: 'success' | 'failure' | 'skipped'` and timing

## Requirements

1. `lib/bootstrapper.ts` exports `bootstrapRepo(repoName: string, options: BootstrapOptions): Promise<BootstrapResult>`
2. The function executes all 5 bootstrap steps in order: create repo → push workflows → set secrets → register → enable actions
3. Each step is tracked in `BootstrapResult.steps` array with `name`, `status` (`success`/`failure`/`skipped`), `durationMs`, and optional `error` message
4. If a step fails, subsequent steps are marked `skipped` and the function returns with overall `success: false`
5. Secret encryption uses `libsodium-wrappers` — fetch the repo's public key via GitHub API, encrypt each secret value, then set it
6. Secrets to set: `ANTHROPIC_API_KEY`, `AGENT_FORGE_API_SECRET`, `AGENT_FORGE_URL` — values sourced from `options.secrets` or process.env fallbacks
7. `getTemplateFiles(options.pipelineLevel)` from `lib/templates.ts` is used to get the workflow files to push
8. Each workflow file from templates is pushed as a separate commit (or as a single commit with multiple files) via `lib/github.ts`
9. `libsodium-wrappers` is added to `package.json` dependencies
10. TypeScript compiles without errors (`npx tsc --noEmit`)
11. New GitHub API methods needed (repo creation, secret setting, actions permissions) are added to `lib/github.ts`

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/bootstrapper-core-library
```

### Step 1: Inspect existing types and related files

Read the relevant existing files to understand exact type shapes:

```bash
cat lib/types.ts
cat lib/github.ts
cat lib/repos.ts
cat lib/templates.ts
```

Look specifically for:
- `BootstrapOptions`, `BootstrapResult`, `BootstrapStep` type definitions in `lib/types.ts`
- Existing GitHub API method patterns in `lib/github.ts` (base URL, auth headers, error handling style)
- `registerRepo` or similar function signatures in `lib/repos.ts`
- `getTemplateFiles` return type and shape in `lib/templates.ts`

### Step 2: Add libsodium-wrappers to package.json

```bash
npm install libsodium-wrappers
npm install --save-dev @types/libsodium-wrappers
```

Verify it appears in `package.json` dependencies.

### Step 3: Add new GitHub API methods to lib/github.ts

Add the following methods to the existing GitHub API wrapper class/object. Match the existing patterns exactly (same auth headers, same error handling, same base URL construction).

Methods to add:

**3a. Create repository**
```typescript
// POST /user/repos
async createRepo(options: {
  name: string;
  private?: boolean;
  description?: string;
  autoInit?: boolean;
}): Promise<{ full_name: string; html_url: string; default_branch: string }>
```

**3b. Get repo public key (for secret encryption)**
```typescript
// GET /repos/{owner}/{repo}/actions/secrets/public-key
async getRepoPublicKey(owner: string, repo: string): Promise<{ key_id: string; key: string }>
```

**3c. Set repo secret**
```typescript
// PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}
async setRepoSecret(owner: string, repo: string, secretName: string, encryptedValue: string, keyId: string): Promise<void>
```

**3d. Enable Actions permissions**
```typescript
// PUT /repos/{owner}/{repo}/actions/permissions
async setActionsPermissions(owner: string, repo: string): Promise<void>
// PUT /repos/{owner}/{repo}/actions/permissions/workflow
async setDefaultWorkflowPermissions(owner: string, repo: string): Promise<void>
```

For `setActionsPermissions`: set `{ "enabled": true, "allowed_actions": "all" }`
For `setDefaultWorkflowPermissions`: set `{ "default_workflow_permissions": "write", "can_approve_pull_request_reviews": true }`

### Step 4: Create lib/bootstrapper.ts

Create the file with the following structure. Fill in the implementation based on the exact types from Step 1.

```typescript
import _sodium from 'libsodium-wrappers';
import { BootstrapOptions, BootstrapResult, BootstrapStep } from './types';
import { getTemplateFiles } from './templates';
import { github } from './github'; // use whatever the export name is
import { registerRepo } from './repos'; // use whatever the export name is

// Helper to track step timing
function makeStepTracker(steps: BootstrapStep[]) {
  return async function runStep<T>(
    name: string,
    fn: () => Promise<T>
  ): Promise<{ result: T | null; failed: boolean }> {
    const start = Date.now();
    try {
      const result = await fn();
      steps.push({
        name,
        status: 'success',
        durationMs: Date.now() - start,
      });
      return { result, failed: false };
    } catch (err) {
      steps.push({
        name,
        status: 'failure',
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      return { result: null, failed: true };
    }
  };
}

// Helper to skip remaining steps
function skipRemaining(names: string[], steps: BootstrapStep[]) {
  for (const name of names) {
    steps.push({ name, status: 'skipped', durationMs: 0 });
  }
}

export async function bootstrapRepo(
  repoName: string,
  options: BootstrapOptions
): Promise<BootstrapResult> {
  const steps: BootstrapStep[] = [];
  const runStep = makeStepTracker(steps);

  const owner = process.env.GITHUB_OWNER ?? options.owner ?? '';
  
  // Step 1: Create GitHub repo
  let repoFullName = `${owner}/${repoName}`;
  const { result: repoResult, failed: step1Failed } = await runStep(
    'create-repo',
    async () => {
      return await github.createRepo({
        name: repoName,
        private: options.private ?? false,
        description: options.description,
        autoInit: true,
      });
    }
  );

  if (step1Failed) {
    skipRemaining(
      ['push-workflows', 'set-secrets', 'register-repo', 'enable-actions'],
      steps
    );
    return { success: false, steps, repoUrl: null };
  }

  if (repoResult) {
    repoFullName = repoResult.full_name;
  }

  // Step 2: Push pipeline workflow files
  const { failed: step2Failed } = await runStep('push-workflows', async () => {
    const templateFiles = getTemplateFiles(options.pipelineLevel);
    // Push all template files as commits via GitHub API
    for (const file of templateFiles) {
      await github.pushFile(
        owner,
        repoName,
        file.path,
        file.content,
        `chore: add pipeline file ${file.path}`
      );
    }
  });

  if (step2Failed) {
    skipRemaining(['set-secrets', 'register-repo', 'enable-actions'], steps);
    return { success: false, steps, repoUrl: repoResult?.html_url ?? null };
  }

  // Step 3: Set repo secrets
  const { failed: step3Failed } = await runStep('set-secrets', async () => {
    await _sodium.ready;
    const sodium = _sodium;

    const publicKeyData = await github.getRepoPublicKey(owner, repoName);
    const keyBytes = sodium.from_base64(
      publicKeyData.key,
      sodium.base64_variants.ORIGINAL
    );

    const secretValues: Record<string, string> = {
      ANTHROPIC_API_KEY:
        options.secrets?.ANTHROPIC_API_KEY ??
        process.env.ANTHROPIC_API_KEY ??
        '',
      AGENT_FORGE_API_SECRET:
        options.secrets?.AGENT_FORGE_API_SECRET ??
        process.env.AGENT_FORGE_API_SECRET ??
        '',
      AGENT_FORGE_URL:
        options.secrets?.AGENT_FORGE_URL ??
        process.env.AGENT_FORGE_URL ??
        '',
    };

    for (const [secretName, secretValue] of Object.entries(secretValues)) {
      if (!secretValue) continue;
      const messageBytes = sodium.from_string(secretValue);
      const encryptedBytes = sodium.crypto_box_seal(messageBytes, keyBytes);
      const encryptedBase64 = sodium.to_base64(
        encryptedBytes,
        sodium.base64_variants.ORIGINAL
      );
      await github.setRepoSecret(
        owner,
        repoName,
        secretName,
        encryptedBase64,
        publicKeyData.key_id
      );
    }
  });

  if (step3Failed) {
    skipRemaining(['register-repo', 'enable-actions'], steps);
    return { success: false, steps, repoUrl: repoResult?.html_url ?? null };
  }

  // Step 4: Register repo in Blob store
  const { failed: step4Failed } = await runStep('register-repo', async () => {
    await registerRepo({
      name: repoName,
      fullName: repoFullName,
      url: repoResult?.html_url ?? `https://github.com/${repoFullName}`,
      pipelineLevel: options.pipelineLevel,
      // add any other required fields based on lib/repos.ts
    });
  });

  if (step4Failed) {
    skipRemaining(['enable-actions'], steps);
    return { success: false, steps, repoUrl: repoResult?.html_url ?? null };
  }

  // Step 5: Enable GitHub Actions permissions
  const { failed: step5Failed } = await runStep('enable-actions', async () => {
    await github.setActionsPermissions(owner, repoName);
    await github.setDefaultWorkflowPermissions(owner, repoName);
  });

  return {
    success: !step5Failed,
    steps,
    repoUrl: repoResult?.html_url ?? null,
  };
}
```

**Important:** Adjust the implementation based on what you see in the actual type definitions from Step 1. The type shapes in the pseudocode above may not exactly match — verify and correct field names, required vs optional properties, and return types.

### Step 5: Reconcile with actual type definitions

After creating the file, carefully re-read `lib/types.ts` for `BootstrapOptions`, `BootstrapResult`, and `BootstrapStep`. Fix any mismatches:

- If `BootstrapStep` uses different field names (e.g., `message` instead of `error`), update accordingly
- If `BootstrapResult` has a different shape (e.g., no `repoUrl` field), update accordingly
- If `BootstrapOptions` has different field names for `pipelineLevel`, `private`, `secrets`, etc., update accordingly
- If `registerRepo` in `lib/repos.ts` takes a different argument shape, update the call

### Step 6: Reconcile with lib/github.ts patterns

After adding new methods to `lib/github.ts`:
- Verify the new methods follow the exact same auth/fetch pattern as existing ones
- If `lib/github.ts` uses a class, add methods to the class
- If it uses a plain object export, add to the object
- If it uses standalone functions, add standalone functions and update the `bootstrapper.ts` import

Also check if `pushFile` (or equivalent commit-a-file method) already exists in `lib/github.ts`. If it does, use the existing one. If not, add it:

```typescript
async pushFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string
): Promise<void> {
  // GET existing file SHA if it exists (for updates)
  // PUT /repos/{owner}/{repo}/contents/{path}
  const encoded = Buffer.from(content).toString('base64');
  // GET existing SHA
  let sha: string | undefined;
  try {
    const existing = await this.request<{ sha: string }>(
      `GET /repos/${owner}/${repo}/contents/${path}`
    );
    sha = existing.sha;
  } catch {
    // file doesn't exist yet, no SHA needed
  }
  await this.request(`PUT /repos/${owner}/${repo}/contents/${path}`, {
    message,
    content: encoded,
    ...(sha ? { sha } : {}),
  });
}
```

### Step 7: Verification

```bash
# Type check
npx tsc --noEmit

# Verify libsodium is in package.json
cat package.json | grep libsodium

# Verify the export exists
grep -n "export async function bootstrapRepo" lib/bootstrapper.ts

# Verify all 5 step names appear
grep -n "create-repo\|push-workflows\|set-secrets\|register-repo\|enable-actions" lib/bootstrapper.ts

# Build check
npm run build 2>&1 | head -50
```

Fix any TypeScript errors before proceeding.

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add bootstrapper core library with 5-step repo bootstrap sequence"
git push origin feat/bootstrapper-core-library
gh pr create \
  --title "feat: Bootstrapper Core Library (lib/bootstrapper.ts)" \
  --body "## Summary

Implements \`lib/bootstrapper.ts\` with the core \`bootstrapRepo(repoName, options)\` function that orchestrates the full 5-step repo bootstrap sequence.

## Changes

- **\`lib/bootstrapper.ts\`** (new): Core bootstrap orchestration with step tracking
- **\`lib/github.ts\`** (modified): Added \`createRepo\`, \`getRepoPublicKey\`, \`setRepoSecret\`, \`setActionsPermissions\`, \`setDefaultWorkflowPermissions\`, \`pushFile\` methods
- **\`package.json\`** (modified): Added \`libsodium-wrappers\` and \`@types/libsodium-wrappers\`

## Bootstrap Steps

1. **create-repo** — POST /user/repos, public by default
2. **push-workflows** — Push all template files from \`getTemplateFiles(pipelineLevel)\`
3. **set-secrets** — Encrypt with libsodium + repo public key, set ANTHROPIC_API_KEY, AGENT_FORGE_API_SECRET, AGENT_FORGE_URL
4. **register-repo** — Register in Blob store via lib/repos.ts
5. **enable-actions** — Set read/write permissions + allow PR approvals

## Acceptance Criteria
- [x] \`bootstrapRepo\` exported with correct signature
- [x] All 5 steps tracked with success/failure/skipped status and timing
- [x] libsodium-wrappers used for secret encryption
- [x] \`getTemplateFiles()\` used for workflow files
- [x] TypeScript compiles without errors
- [x] libsodium-wrappers in package.json"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/bootstrapper-core-library
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Common Failure Modes

**libsodium TypeScript errors:** If `_sodium.ready` or `sodium.from_base64` doesn't compile, try:
```typescript
import sodium from 'libsodium-wrappers';
await sodium.ready;
// then use sodium.crypto_box_seal etc.
```

**`BootstrapStep` shape mismatch:** Read `lib/types.ts` carefully — the field might be `errorMessage` not `error`, or `duration` not `durationMs`. Always use actual types.

**`registerRepo` signature unknown:** Check `lib/repos.ts` for the exact function name and parameter shape. It may be called `saveRepo`, `addRepo`, or similar.

**`getTemplateFiles` return type:** Check `lib/templates.ts` — the returned objects might use `filePath`/`fileContent` instead of `path`/`content`.

**GitHub API 404 on newly created repo:** Add a 2-second delay after `createRepo` before pushing files — GitHub needs a moment to initialize the repo.

**Escalation:** If blocked on ambiguous types that can't be resolved from existing code:
```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "bootstrapper-core-library",
    "reason": "Cannot resolve BootstrapOptions/BootstrapResult/BootstrapStep type shapes from lib/types.ts — types may not yet exist",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "1",
      "error": "Types BootstrapOptions, BootstrapResult, BootstrapStep not found in lib/types.ts",
      "filesChanged": []
    }
  }'
```