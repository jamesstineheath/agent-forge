# Agent Forge -- QA Agent PR Comment Formatter

## Metadata
- **Branch:** `feat/qa-agent-format-comment`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** .github/actions/tlm-qa-agent/src/format-comment.ts

## Context

Agent Forge is a dev orchestration platform (Next.js on Vercel). The QA Agent is a TLM (Team Learning Machine) agent implemented as a GitHub Action at `.github/actions/tlm-qa-agent/`. It runs smoke tests and evaluates acceptance criteria against preview deployments.

The existing smoke test runner was added in a recent PR (`feat: add QA agent smoke test runner (Pass 1)`), which created the scaffolding at `.github/actions/tlm-qa-agent/src/smoke-test.ts` with its own `package.json`, `tsconfig.json`, etc.

This task creates `format-comment.ts` — a pure formatting module that takes aggregated results from all three QA passes and emits a structured markdown string suitable for posting as a PR comment. It has no external dependencies (pure TypeScript string manipulation).

The module must define and export the `QAReport` interface, `SmokeTestResult` (imported or defined), `formatPRComment`, and `computeVerdict`.

## Requirements

1. Create `.github/actions/tlm-qa-agent/src/format-comment.ts` exporting `QAReport`, `formatPRComment`, and `computeVerdict`.
2. `formatPRComment(report: QAReport): string` returns a markdown string with:
   - Header line with emoji status indicator: ✅ for `pass`, ⚠️ for `advisory-pass`, ❌ for `issues-found` or `failed`
   - Preview URL as a markdown link
   - Smoke Test section listing each check with per-check emoji (✅ pass, ❌ fail, ⚠️ skip/unknown)
   - Acceptance Criteria Verification section listing each criterion with per-criterion emoji
   - Verdict line with counts: `X/Y criteria verified, Z not testable`
   - Footer: `> ⚠️ Advisory Mode — QA Agent results are informational only`
3. `computeVerdict(criteriaResults)` returns `{ verdict, summary }`:
   - `'pass'` when all criteria are `'pass'`
   - `'advisory-pass'` when no failures but some are `'skip'`
   - `'issues-found'` when any criteria are `'fail'`
   - `'failed'` reserved for smoke test infrastructure failures (computeVerdict focuses on criteria logic; `'failed'` can be returned when criteriaResults is empty and there are no passes)
4. `SmokeTestResult` interface must be defined (or imported from `smoke-test.ts` if it's already exported there) — includes at minimum an array of `{ name: string; status: 'pass' | 'fail' | 'skip'; message?: string }`.
5. The module must compile with the existing `tsconfig.json` in `.github/actions/tlm-qa-agent/`.
6. No new npm dependencies required — pure TypeScript.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/qa-agent-format-comment
```

### Step 1: Inspect existing action scaffolding

Read the existing files to understand types and tsconfig before writing new code:

```bash
cat .github/actions/tlm-qa-agent/src/smoke-test.ts
cat .github/actions/tlm-qa-agent/tsconfig.json
cat .github/actions/tlm-qa-agent/package.json
```

Note any exported types from `smoke-test.ts` (particularly whether `SmokeTestResult` or a check result type is already exported). If it is, import from there rather than redefining.

### Step 2: Create `format-comment.ts`

Create `.github/actions/tlm-qa-agent/src/format-comment.ts` with the following implementation. Adjust imports based on what you found in Step 1 — if `SmokeTestResult`-related types are already in `smoke-test.ts`, import them; otherwise define them locally.

```typescript
// .github/actions/tlm-qa-agent/src/format-comment.ts

export interface SmokeCheckResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  message?: string;
}

export interface SmokeTestResult {
  passed: boolean;
  checks: SmokeCheckResult[];
  durationMs?: number;
}

export interface CriterionResult {
  criterion: string;
  status: 'pass' | 'fail' | 'skip';
  evidence: string;
}

export interface QAReport {
  previewUrl: string;
  smokeTest: SmokeTestResult;
  criteriaResults: CriterionResult[];
  verdict: 'pass' | 'advisory-pass' | 'issues-found' | 'failed';
  verdictSummary: string;
}

function statusEmoji(status: 'pass' | 'fail' | 'skip' | string): string {
  switch (status) {
    case 'pass': return '✅';
    case 'fail': return '❌';
    case 'skip': return '⚠️';
    default: return '⚠️';
  }
}

function verdictEmoji(verdict: QAReport['verdict']): string {
  switch (verdict) {
    case 'pass': return '✅';
    case 'advisory-pass': return '⚠️';
    case 'issues-found': return '❌';
    case 'failed': return '❌';
    default: return '⚠️';
  }
}

function verdictLabel(verdict: QAReport['verdict']): string {
  switch (verdict) {
    case 'pass': return 'Pass';
    case 'advisory-pass': return 'Advisory Pass';
    case 'issues-found': return 'Issues Found';
    case 'failed': return 'Failed';
    default: return 'Unknown';
  }
}

export function computeVerdict(
  criteriaResults: QAReport['criteriaResults']
): { verdict: QAReport['verdict']; summary: string } {
  if (criteriaResults.length === 0) {
    return {
      verdict: 'failed',
      summary: 'No criteria evaluated.',
    };
  }

  const passed = criteriaResults.filter((r) => r.status === 'pass').length;
  const failed = criteriaResults.filter((r) => r.status === 'fail').length;
  const skipped = criteriaResults.filter((r) => r.status === 'skip').length;
  const total = criteriaResults.length;

  if (failed > 0) {
    return {
      verdict: 'issues-found',
      summary: `${passed}/${total} criteria verified, ${skipped} not testable. ${failed} failure(s) found.`,
    };
  }

  if (skipped > 0) {
    return {
      verdict: 'advisory-pass',
      summary: `${passed}/${total} criteria verified, ${skipped} not testable.`,
    };
  }

  return {
    verdict: 'pass',
    summary: `${passed}/${total} criteria verified, 0 not testable.`,
  };
}

export function formatPRComment(report: QAReport): string {
  const emoji = verdictEmoji(report.verdict);
  const label = verdictLabel(report.verdict);

  const lines: string[] = [];

  // Header
  lines.push(`## ${emoji} QA Agent Report — ${label}`);
  lines.push('');

  // Preview URL
  lines.push(`**Preview:** [${report.previewUrl}](${report.previewUrl})`);
  lines.push('');

  // Smoke Test section
  lines.push('### 🔍 Smoke Test');
  lines.push('');

  if (report.smokeTest.checks.length === 0) {
    lines.push('_No smoke test checks recorded._');
  } else {
    for (const check of report.smokeTest.checks) {
      const icon = statusEmoji(check.status);
      const detail = check.message ? ` — ${check.message}` : '';
      lines.push(`- ${icon} **${check.name}**${detail}`);
    }
  }

  if (report.smokeTest.durationMs !== undefined) {
    lines.push('');
    lines.push(`_Completed in ${report.smokeTest.durationMs}ms_`);
  }

  lines.push('');

  // Acceptance Criteria section
  lines.push('### ✔️ Acceptance Criteria Verification');
  lines.push('');

  if (report.criteriaResults.length === 0) {
    lines.push('_No acceptance criteria evaluated._');
  } else {
    for (const cr of report.criteriaResults) {
      const icon = statusEmoji(cr.status);
      lines.push(`- ${icon} **${cr.criterion}**`);
      if (cr.evidence) {
        lines.push(`  - _${cr.evidence}_`);
      }
    }
  }

  lines.push('');

  // Verdict line with counts
  const passed = report.criteriaResults.filter((r) => r.status === 'pass').length;
  const skipped = report.criteriaResults.filter((r) => r.status === 'skip').length;
  const total = report.criteriaResults.length;

  lines.push(
    `**Verdict:** ${emoji} ${label} — ${passed}/${total} criteria verified, ${skipped} not testable`
  );
  lines.push('');

  // Verdict summary if provided
  if (report.verdictSummary) {
    lines.push(`> ${report.verdictSummary}`);
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('> ⚠️ Advisory Mode — QA Agent results are informational only');

  return lines.join('\n');
}
```

### Step 3: Verify TypeScript compilation

```bash
cd .github/actions/tlm-qa-agent
npx tsc --noEmit
```

If there are import conflicts (e.g., `SmokeTestResult` already exported from `smoke-test.ts` with a different shape), reconcile by either:
- Importing from `smoke-test.ts` and removing the local definition
- Renaming the local interface (e.g., `QASmokeTestResult`) and updating `QAReport` accordingly

Re-run `npx tsc --noEmit` until clean.

### Step 4: Verify no circular imports or missing dependencies

```bash
cd .github/actions/tlm-qa-agent
# Ensure no new packages were accidentally added
cat package.json
# Confirm the file exists and looks correct
cat src/format-comment.ts
```

### Step 5: Commit, push, open PR

```bash
cd "$(git rev-parse --show-toplevel)"
git add .github/actions/tlm-qa-agent/src/format-comment.ts
git commit -m "feat: add QA agent PR comment formatter

- Exports formatPRComment(report: QAReport): string
- Exports computeVerdict(criteriaResults): { verdict, summary }
- Emoji status indicators per check and criterion (✅/⚠️/❌)
- Advisory Mode footer in all comments
- Pure TypeScript, no new dependencies"
git push origin feat/qa-agent-format-comment
gh pr create \
  --title "feat: add QA agent PR comment formatter" \
  --body "## Summary

Adds \`.github/actions/tlm-qa-agent/src/format-comment.ts\` — a pure TypeScript module for formatting QA Agent results into structured PR comments.

## Exports

- \`QAReport\` interface (and supporting interfaces)
- \`formatPRComment(report: QAReport): string\` — produces markdown PR comment
- \`computeVerdict(criteriaResults): { verdict, summary }\` — derives overall verdict

## Comment Format

- Header with emoji verdict indicator (✅/⚠️/❌)
- Preview URL link
- Smoke Test section with per-check emoji results
- Acceptance Criteria Verification section with per-criterion results
- Verdict line: \`X/Y criteria verified, Z not testable\`
- Footer: \`Advisory Mode — QA Agent results are informational only\`

## Verdict Logic

| Condition | Verdict |
|---|---|
| All criteria pass | \`pass\` |
| No failures, some skipped | \`advisory-pass\` |
| Any failures | \`issues-found\` |
| No criteria / infra error | \`failed\` |

## Testing

\`npx tsc --noEmit\` passes with no errors.

No new npm dependencies added." \
  --base main
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/qa-agent-format-comment
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If you encounter a blocker (e.g., `SmokeTestResult` is defined in `smoke-test.ts` with an incompatible shape requiring architectural discussion, or tsconfig settings prevent compilation in unexpected ways):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "qa-agent-format-comment",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": [".github/actions/tlm-qa-agent/src/format-comment.ts"]
    }
  }'
```