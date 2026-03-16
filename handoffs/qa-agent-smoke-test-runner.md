# Agent Forge -- QA Agent Smoke Test Runner

## Metadata
- **Branch:** `feat/qa-agent-smoke-test-runner`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** .github/actions/tlm-qa-agent/src/smoke-test.ts

## Context

The TLM QA Agent is a GitHub Action being built in `.github/actions/tlm-qa-agent/`. Recent PRs have established:
- The action scaffold at `.github/actions/tlm-qa-agent/action.yml`
- An acceptance criteria parser at `.github/actions/tlm-qa-agent/src/parse-criteria.ts`
- A workflow trigger at `.github/workflows/tlm-qa-agent.yml`
- A stub at `.github/actions/tlm-qa-agent/run-qa.ts`

This task adds the **Pass 1 smoke test module**: a TypeScript file that performs basic HTTP health checks against a preview deployment URL. It uses native Node 20 `fetch` with `AbortController` for timeouts — no Playwright required. This smoke test will be consumed by the broader QA agent orchestration logic.

## Requirements

1. Create `.github/actions/tlm-qa-agent/src/smoke-test.ts` exporting `SmokeTestResult` interface and `runSmokeTest` function with exact signatures as specified.
2. Root check: HTTP GET `previewUrl` (trailing-slash-normalized), verify 200 status, and scan response body for error markers: `'Application error'`, `'Internal Server Error'`, `'This page could not be found'`.
3. Route checks: For each route in `touchedRoutes`, GET `${previewUrl}${route}` with `X-QA-Agent-Token: ${qaToken}` header and 10s `AbortController` timeout.
4. Route checks: 5xx status codes → `passed: false`; 4xx status codes → `passed: true` (auth/param expected); 2xx/3xx → `passed: true`.
5. `overallPassed` is `true` only if `rootCheck.passed === true` AND no route check has `passed === false`.
6. All network errors (fetch throws, timeout abort) are caught and recorded in the relevant check's `error` field with `passed: false`.
7. The module must compile cleanly under the tsconfig already present in the action directory (or a reasonable default if none exists). No new dependencies required.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/qa-agent-smoke-test-runner
```

### Step 1: Inspect existing action structure
```bash
ls .github/actions/tlm-qa-agent/
cat .github/actions/tlm-qa-agent/action.yml
cat .github/actions/tlm-qa-agent/package.json 2>/dev/null || echo "no package.json"
ls .github/actions/tlm-qa-agent/src/ 2>/dev/null || echo "no src dir yet"
cat .github/actions/tlm-qa-agent/src/parse-criteria.ts 2>/dev/null || echo "not found"
```

Note the tsconfig, Node version target, and any existing import patterns used in `parse-criteria.ts` so the new file matches conventions.

### Step 2: Create the smoke-test module

Create `.github/actions/tlm-qa-agent/src/smoke-test.ts` with the following content:

```typescript
export interface SmokeTestResult {
  rootCheck: { passed: boolean; statusCode: number; error?: string };
  routeChecks: Array<{
    route: string;
    passed: boolean;
    statusCode: number;
    error?: string;
  }>;
  overallPassed: boolean;
}

const TIMEOUT_MS = 10_000;
const ERROR_MARKERS = [
  "Application error",
  "Internal Server Error",
  "This page could not be found",
];

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUrl(base: string): string {
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

export async function runSmokeTest(
  previewUrl: string,
  touchedRoutes: string[],
  qaToken: string
): Promise<SmokeTestResult> {
  const base = normalizeUrl(previewUrl);

  // --- Root check ---
  const rootCheck: SmokeTestResult["rootCheck"] = {
    passed: false,
    statusCode: 0,
  };

  try {
    const res = await fetchWithTimeout(`${base}/`);
    rootCheck.statusCode = res.status;

    if (res.status !== 200) {
      rootCheck.passed = false;
      rootCheck.error = `Expected 200, got ${res.status}`;
    } else {
      const body = await res.text();
      const foundMarker = ERROR_MARKERS.find((marker) => body.includes(marker));
      if (foundMarker) {
        rootCheck.passed = false;
        rootCheck.error = `Error page marker detected: "${foundMarker}"`;
      } else {
        rootCheck.passed = true;
      }
    }
  } catch (err: unknown) {
    rootCheck.passed = false;
    rootCheck.error =
      err instanceof Error ? err.message : "Unknown fetch error";
  }

  // --- Route checks ---
  const routeChecks: SmokeTestResult["routeChecks"] = [];

  for (const route of touchedRoutes) {
    const url = `${base}${route.startsWith("/") ? route : `/${route}`}`;
    const check: SmokeTestResult["routeChecks"][number] = {
      route,
      passed: false,
      statusCode: 0,
    };

    try {
      const res = await fetchWithTimeout(url, {
        headers: {
          "X-QA-Agent-Token": qaToken,
        },
      });
      check.statusCode = res.status;

      if (res.status >= 500) {
        check.passed = false;
        check.error = `5xx response: ${res.status}`;
      } else {
        // 2xx, 3xx, 4xx are all acceptable (4xx = auth/param expected)
        check.passed = true;
      }
    } catch (err: unknown) {
      check.passed = false;
      check.error =
        err instanceof Error ? err.message : "Unknown fetch error";
    }

    routeChecks.push(check);
  }

  // --- Overall result ---
  const overallPassed =
    rootCheck.passed && routeChecks.every((r) => r.passed);

  return { rootCheck, routeChecks, overallPassed };
}
```

### Step 3: Verify TypeScript compilation

Check if there is a `tsconfig.json` in the action directory:

```bash
cat .github/actions/tlm-qa-agent/tsconfig.json 2>/dev/null || echo "no tsconfig"
```

If no `tsconfig.json` exists in the action directory, create one:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

Run typecheck from the action directory:

```bash
cd .github/actions/tlm-qa-agent
npx tsc --noEmit 2>&1 || true
cd -
```

If there are type errors related to `fetch` or `AbortController` not being found (Node typings), check the `package.json` for `@types/node`. If missing, add it:

```bash
cd .github/actions/tlm-qa-agent
# Check if @types/node is present
cat package.json | grep types/node || echo "missing @types/node"
# If missing and npm install is available:
npm install --save-dev @types/node 2>/dev/null || true
cd -
```

Re-run typecheck and confirm it passes cleanly.

### Step 4: Verify acceptance criteria manually

Do a quick sanity-check review of the file you created:

```bash
# Confirm exports are present
grep -n "export interface SmokeTestResult" .github/actions/tlm-qa-agent/src/smoke-test.ts
grep -n "export async function runSmokeTest" .github/actions/tlm-qa-agent/src/smoke-test.ts

# Confirm error markers are present
grep -n "Application error\|Internal Server Error\|This page could not be found" .github/actions/tlm-qa-agent/src/smoke-test.ts

# Confirm X-QA-Agent-Token header
grep -n "X-QA-Agent-Token" .github/actions/tlm-qa-agent/src/smoke-test.ts

# Confirm AbortController usage
grep -n "AbortController\|abort" .github/actions/tlm-qa-agent/src/smoke-test.ts

# Confirm 5xx failure logic
grep -n "status >= 500" .github/actions/tlm-qa-agent/src/smoke-test.ts

# Confirm overallPassed logic
grep -n "overallPassed" .github/actions/tlm-qa-agent/src/smoke-test.ts
```

All checks should return matches.

### Step 5: Run top-level build/typecheck if present

```bash
npx tsc --noEmit 2>/dev/null && echo "Root tsc OK" || echo "Root tsc skipped or no tsconfig"
npm run build 2>/dev/null || echo "No root build script"
npm test 2>/dev/null || echo "No root test script"
```

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add QA agent smoke test runner (Pass 1)"
git push origin feat/qa-agent-smoke-test-runner
gh pr create \
  --title "feat: QA Agent smoke test runner" \
  --body "## Summary

Adds \`.github/actions/tlm-qa-agent/src/smoke-test.ts\` — the Pass 1 smoke test module for the TLM QA Agent.

## Changes
- **New file**: \`.github/actions/tlm-qa-agent/src/smoke-test.ts\`

## Functionality
- \`runSmokeTest(previewUrl, touchedRoutes, qaToken)\` performs HTTP health checks against a preview deployment
- **Root check**: GET \`previewUrl/\`, verify HTTP 200, scan body for error page markers (\`Application error\`, \`Internal Server Error\`, \`This page could not be found\`)
- **Route checks**: GET each touched route with \`X-QA-Agent-Token\` header + 10s AbortController timeout; 5xx = fail, 4xx/2xx/3xx = pass
- **overallPassed**: true only when root check passes and no route returns 5xx
- Uses native Node 20 \`fetch\` — no Playwright or additional dependencies

## Acceptance Criteria
- [x] \`smoke-test.ts\` exports \`runSmokeTest\` with typed \`SmokeTestResult\` return
- [x] Root check detects error page markers in response body
- [x] Route checks include \`X-QA-Agent-Token\` header and 10s AbortController timeout
- [x] 5xx responses are marked failed; 4xx responses are marked passed
- [x] \`overallPassed\` is true only if root check passes and no route returns 5xx
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/qa-agent-smoke-test-runner
FILES CHANGED: .github/actions/tlm-qa-agent/src/smoke-test.ts
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

### Escalation

If you encounter a blocker you cannot resolve autonomously (e.g., tsconfig conflicts, missing Node type definitions that can't be resolved, ambiguous existing code patterns):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "qa-agent-smoke-test-runner",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": [".github/actions/tlm-qa-agent/src/smoke-test.ts"]
    }
  }'
```