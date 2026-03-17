# Agent Forge -- A6: Plan Quality Gate in ATC

## Metadata
- **Branch:** `feat/a6-plan-quality-gate-atc`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/atc.ts

## Context

Agent Forge's ATC (Air Traffic Controller) runs as a Vercel cron job defined in `lib/atc.ts`. Section 4.5 of the ATC detects Notion projects with status `'Execute'` and calls `decomposeProject()` to generate work items from the plan.

This task adds a **plan quality gate** to section 4.5: before decomposing, call `validatePlan(project.id)` from `lib/plan-validator` (already implemented). If validation fails, skip decomposition and send an escalation email with the specific issues found. If validation passes, log success and proceed to decomposition as before.

The `sendProjectEscalationEmail` function exists in `lib/gmail.ts` (recently added per PR history). The `validatePlan` function exists in `lib/plan-validator.ts`.

Key constraint: the validation gate must use `continue` (or equivalent control flow) to skip only the failing project within the loop — other projects in the same ATC cycle must still be processed.

## Requirements

1. `lib/atc.ts` imports `validatePlan` from `./plan-validator`
2. In ATC section 4.5, before every call to `decomposeProject()`, `validatePlan(project.id)` is awaited
3. When `validation.valid === false`, decomposition is skipped, `sendProjectEscalationEmail` is called with a formatted issue list, and a `console.log` records the failure
4. When `validation.valid === true`, a `console.log` confirms success and decomposition proceeds as before
5. `npm run build` succeeds with no TypeScript errors

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/a6-plan-quality-gate-atc
```

### Step 1: Inspect existing code

Read the relevant files to understand exact function signatures and loop structure before making changes:

```bash
# Understand the full section 4.5 loop in ATC
grep -n "4.5\|decomposeProject\|Execute\|sendProjectEscalationEmail" lib/atc.ts | head -60

# Check validatePlan signature and return type
cat lib/plan-validator.ts

# Check sendProjectEscalationEmail signature
grep -n "sendProjectEscalationEmail" lib/gmail.ts | head -20
grep -n -A 10 "export.*sendProjectEscalationEmail" lib/gmail.ts
```

### Step 2: Add the plan quality gate to lib/atc.ts

Locate the import block at the top of `lib/atc.ts` and add:

```typescript
import { validatePlan } from './plan-validator';
```

Then locate section 4.5 — the loop that processes projects with status `'Execute'` and calls `decomposeProject()`. Insert the validation block immediately before the `decomposeProject()` call. The pattern to insert:

```typescript
// §4.5 Plan Quality Gate
const validation = await validatePlan(project.id);
if (!validation.valid) {
  const issueList = validation.issues
    .map((i: { severity: string; section: string; message: string }) =>
      `[${i.severity.toUpperCase()}] ${i.section}: ${i.message}`
    )
    .join('\n');

  await sendProjectEscalationEmail({
    projectId: project.id,
    projectName: project.name,
    subject: `Plan validation failed for ${project.name}`,
    body: `Plan validation found ${validation.issues.length} issue(s):\n\n${issueList}\n\nPlease fix the plan and re-trigger.`,
  });

  console.log(
    `[ATC §4.5] Plan validation failed for ${project.name}: ${validation.issues.length} issues`
  );
  continue;
}

console.log(`[ATC §4.5] Plan validated for ${project.name}, proceeding to decomposition`);
// Existing decomposeProject() call follows...
```

**Important notes:**
- Adapt the `sendProjectEscalationEmail` call to match its actual signature in `lib/gmail.ts` (it may accept positional args or a different object shape — check Step 1 output)
- If the loop uses `for...of`, `continue` is correct. If it uses `forEach` or `map`, replace `continue` with `return` inside the callback
- If `project.name` doesn't exist on the project type (it may be `project.title` or similar), use whatever field the existing `decomposeProject()` call uses for the project name
- If the type for `validation.issues` items is already typed in `plan-validator.ts`, remove the inline type annotation and rely on inference

### Step 3: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

If there are type errors:
- Check the exact return type of `validatePlan` in `lib/plan-validator.ts` and adjust field access accordingly (e.g., `i.severity` vs `i.level`)
- Check the exact parameter type of `sendProjectEscalationEmail` in `lib/gmail.ts` and adjust the call accordingly
- Fix any import path issues (`./plan-validator` vs `@/lib/plan-validator` — use whatever pattern the rest of `lib/atc.ts` uses for local imports)

### Step 4: Build verification

```bash
npm run build
```

Resolve any build errors before proceeding.

### Step 5: Commit, push, open PR

```bash
git add lib/atc.ts
git commit -m "feat: add plan quality gate in ATC section 4.5 (A6)"
git push origin feat/a6-plan-quality-gate-atc
gh pr create \
  --title "feat: A6 — Plan Quality Gate in ATC section 4.5" \
  --body "## Summary

Adds a plan validation gate to ATC section 4.5 before decomposition.

### Changes
- **\`lib/atc.ts\`**: Imports \`validatePlan\` from \`./plan-validator\` and calls it before every \`decomposeProject()\` invocation in section 4.5. On failure, sends an escalation email with formatted issue list and skips decomposition for that project. On success, logs confirmation and proceeds normally.

### Behaviour
- Valid plan → \`[ATC §4.5] Plan validated for <name>, proceeding to decomposition\` + decompose
- Invalid plan → escalation email + \`[ATC §4.5] Plan validation failed for <name>: N issues\` + skip

### Acceptance Criteria
- [x] \`lib/atc.ts\` imports \`validatePlan\` from \`lib/plan-validator\`
- [x] Validation called before \`decomposeProject()\` for each new project
- [x] Failed validation → skip decomposition + send escalation email
- [x] Passed validation → proceed with console log
- [x] \`npm run build\` succeeds"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/a6-plan-quality-gate-atc
FILES CHANGED: [lib/atc.ts]
SUMMARY: [what was done]
ISSUES: [what failed — include exact TypeScript error if type mismatch]
NEXT STEPS: [what remains]
```

If blocked by ambiguous signatures (e.g., `validatePlan` or `sendProjectEscalationEmail` have unexpected shapes that can't be resolved by reading the source), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "a6-plan-quality-gate-atc",
    "reason": "Cannot resolve function signature mismatch for validatePlan or sendProjectEscalationEmail — need human to confirm expected types",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "2",
      "error": "<paste exact TypeScript error here>",
      "filesChanged": ["lib/atc.ts"]
    }
  }'
```