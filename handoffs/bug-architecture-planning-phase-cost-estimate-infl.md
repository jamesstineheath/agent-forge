<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- Bug: Architecture-Planning Phase Cost Estimate Inflated ~46x

## Metadata
- **Branch:** `fix/architecture-planning-cost-estimate-inflated`
- **Priority:** low
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** `lib/atc/supervisor.ts`

## Context

The Supervisor agent's `architecture-planning` phase reports wildly inflated cost estimates. For "Dashboard UI Alignment (PRD-53)", which has 8 acceptance criteria at roughly $30 total (~$3.75/AC), the phase reported "est. $1395" — off by ~46x.

Evidence from Supervisor phase log (2026-03-21T00:00 UTC):
```
Phase architecture-planning: success (72390ms)
Decision: Generated architecture plan for "Dashboard UI Alignment — Post-Stabilization" — 8 criterion plans, est. $1395
```

The architecture planner is almost certainly summing raw Anthropic API token costs for the entire execution chain (Opus calls during decomposition, execution, code review, etc.) rather than using the pipeline cost convention from acceptance criteria. The pipeline convention is:
- **Simple**: $3–5 per criterion
- **Moderate**: $5–8 per criterion
- **Complex**: $8–15 per criterion

For 8 criteria at ~$5 average that's ~$40, not $1395.

The fix is in `lib/atc/supervisor.ts` where the architecture planning prompt or cost aggregation logic is constructed. The cost estimate in the generated plan should reflect the PRD acceptance-criteria cost convention, not raw API token spend.

**Concurrent work to avoid:** The concurrent work item modifies `lib/atc/supervisor.ts` (among others). Since this fix is also in `lib/atc/supervisor.ts`, the executor must be careful. The concurrent branch is `feat/fix-decomposition-coordinator-fetch-timeout-still-`. Check if that branch has been merged before starting; if it hasn't, coordinate carefully to only touch the cost estimation logic and avoid the decomposition coordinator fetch timeout sections.

## Requirements

1. Locate the architecture-planning cost estimation logic in `lib/atc/supervisor.ts` (search for where the `$1395`-scale estimate is constructed — likely a prompt instruction or a post-generation aggregation).
2. Fix the cost estimation so that per-criterion estimates follow the pipeline convention: $3–5 (simple), $5–8 (moderate), $8–15 (complex).
3. The total project cost estimate should be a sum of per-criterion estimates using the convention above, not raw API token costs.
4. The decision string logged by the phase (e.g., "est. $1395") should reflect the corrected estimate after the fix.
5. Do not modify any of the decomposition coordinator fetch timeout logic in `lib/atc/supervisor.ts` (concurrent work item scope).
6. TypeScript must compile cleanly (`npx tsc --noEmit`).
7. No new tests are required (simple prompt/logic fix), but verify no existing tests break.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/architecture-planning-cost-estimate-inflated
```

### Step 1: Understand the concurrent work situation

Before touching any file, check if the concurrent branch has already merged:

```bash
gh pr list --repo jamesstineheath/agent-forge --state open \
  --search "fix-decomposition-coordinator-fetch-timeout"
```

If it's already merged, do a `git pull` on main and rebase. If it's still open, proceed carefully — only touch cost estimation code in `lib/atc/supervisor.ts`.

### Step 2: Locate the inflated cost estimation logic

Search for the cost estimation in the supervisor architecture planning phase:

```bash
# Find the architecture-planning phase handler
grep -n "architecture-planning\|architecture_planning\|architecturePlanning" lib/atc/supervisor.ts | head -40

# Find cost estimation patterns
grep -n "est\.\|cost\|estimate\|\$\|token\|price\|1395" lib/atc/supervisor.ts | head -60

# Search for where the cost string is assembled
grep -n "criterion plan\|criterionPlan\|per.criterion\|costPerAC\|acCost" lib/atc/supervisor.ts | head -40
```

Also check if there's a prompt string that instructs Claude to estimate costs in a particular way:

```bash
grep -n -A 5 -B 5 "cost.*criterion\|criterion.*cost\|estimate.*dollar\|\\\$[0-9]" lib/atc/supervisor.ts | head -80
```

### Step 3: Identify the root cause

The inflation is likely one of:

**Scenario A — Prompt instructs Claude to estimate raw API costs**: The architecture-planning prompt tells Claude to estimate "total cost" without specifying it should use the $3–5/$5–8/$8–15 per-criterion pipeline convention. Claude then estimates Opus API token costs for the full execution pipeline.

**Scenario B — Post-generation aggregation multiplies costs**: After Claude generates per-criterion plans, the TypeScript code multiplies by some factor (e.g., number of agent calls × token prices) producing inflated totals.

**Scenario C — Cost extracted from wrong field**: Claude returns a cost field but the code reads a raw token count instead of the dollar estimate.

Read the relevant section carefully to understand which scenario applies.

### Step 4: Fix the cost estimation

**If Scenario A (prompt issue):**

Find the prompt template for the architecture-planning phase and add explicit cost estimation instructions. The prompt should include something like:

```typescript
// In the architecture planning prompt, add/update cost estimation instructions:
const costGuidance = `
For each acceptance criterion, estimate the implementation cost using this pipeline convention:
- Simple criterion (UI tweak, config change, single function): $3–5
- Moderate criterion (new component, API integration, multi-file change): $5–8  
- Complex criterion (new subsystem, significant refactor, cross-cutting concern): $8–15

Do NOT estimate raw API token costs. Estimate the pipeline work item cost per the above convention.
Total project cost = sum of per-criterion estimates.
`;
```

**If Scenario B (aggregation bug):**

Find where the total is computed and replace the multiplication with a simple sum of per-criterion estimates:

```typescript
// Replace something like:
const totalCost = criterionPlans.reduce((sum, plan) => {
  return sum + plan.tokenCount * OPUS_PRICE_PER_TOKEN * CALLS_PER_CRITERION;
}, 0);

// With:
const totalCost = criterionPlans.reduce((sum, plan) => {
  return sum + plan.estimatedCost; // Already uses pipeline convention
}, 0);
```

**If Scenario C (wrong field):**

Fix the field extraction to use the dollar estimate, not the token count.

### Step 5: Verify the fix produces reasonable estimates

After making the change, trace through the logic manually for the failing example:
- 8 criteria × ~$5 average = ~$40 total
- The decision string should read something like "est. $40" not "est. $1395"

Add a comment near the estimation logic explaining the convention:

```typescript
// Cost convention: $3-5 simple, $5-8 moderate, $8-15 complex per criterion.
// These are pipeline work item costs, NOT raw Anthropic API token costs.
```

### Step 6: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding.

### Step 7: Run existing tests

```bash
npm test -- --passWithNoTests 2>&1 | tail -30
```

Ensure no existing tests are broken.

### Step 8: Commit, push, open PR

```bash
git add lib/atc/supervisor.ts
git add -A  # in case other files were touched
git commit -m "fix: correct architecture-planning cost estimate to use pipeline convention

The architecture-planning Supervisor phase was reporting wildly inflated
cost estimates (e.g., \$1395 for 8 ACs that should total ~\$40). Root cause:
[describe what you found - prompt missing convention / aggregation bug / etc.]

Fix: [describe what you changed]

Now uses pipeline cost convention: \$3-5 simple, \$5-8 moderate,
\$8-15 complex per criterion — matching PRD acceptance criteria estimates."

git push origin fix/architecture-planning-cost-estimate-inflated

gh pr create \
  --title "fix: correct architecture-planning phase cost estimate (was ~46x inflated)" \
  --body "## Problem
The Supervisor \`architecture-planning\` phase reported \`est. \$1395\` for a project with 8 acceptance criteria that should total ~\$30–40. Off by ~46x.

## Root Cause
[Fill in after investigation]

## Fix
[Fill in after fix]

## Convention
Cost estimates now use the pipeline convention:
- Simple: \$3–5/criterion
- Moderate: \$5–8/criterion  
- Complex: \$8–15/criterion

This matches how PRD acceptance criteria are estimated throughout Agent Forge.

## Testing
- TypeScript compiles cleanly
- Existing tests pass
- Manual trace: 8 criteria × ~\$5 avg = ~\$40 (vs previous \$1395)

Fixes: architecture-planning cost estimate inflated ~46x"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: fix/architecture-planning-cost-estimate-inflated
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed or was unclear]
NEXT STEPS: [what remains - e.g., "Root cause is in prompt at line X, needs cost convention text added"]
```

## Escalation

If the cost estimation logic is not in `lib/atc/supervisor.ts` and cannot be found after a thorough search, escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "bug-architecture-planning-cost-estimate-inflated",
    "reason": "Cannot locate cost estimation logic for architecture-planning phase. Searched lib/atc/supervisor.ts exhaustively but could not find where the $1395-scale estimate is constructed.",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "2-3",
      "error": "Cost estimation logic not found in expected location",
      "filesChanged": []
    }
  }'
```