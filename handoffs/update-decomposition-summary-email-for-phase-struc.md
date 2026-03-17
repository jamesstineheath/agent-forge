# Agent Forge -- Update decomposition summary email for phase structure

## Metadata
- **Branch:** `feat/decomposition-email-phase-structure`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/gmail.ts, lib/types.ts

## Context

Agent Forge's decomposer recently gained recursive sub-phase decomposition (see recent merged PRs). When a project is decomposed into multiple phases, the ATC dispatches work items in topological order. However, the Gmail decomposition summary email still renders a flat item list — it doesn't convey the phase structure to the project owner.

The goal is to update `sendDecompositionSummary` (or equivalent) in `lib/gmail.ts` to accept an optional `PhaseBreakdown` parameter. When provided, the email renders a phase-structured view showing each phase's items and cross-phase dependencies. When not provided, the email is identical to current behavior.

The `PhaseBreakdown` type already exists in `lib/types.ts` (introduced by the sub-phase decomposition work). You must read that file first to understand its exact shape before writing any code.

## Requirements

1. The `sendDecompositionSummary` function signature must accept an optional `phaseBreakdown?: PhaseBreakdown` parameter without breaking existing callers.
2. When `phaseBreakdown` is **not** provided (or when there is only one phase / <=15 items with no meaningful phase structure), the email output must be **identical** to the current behavior.
3. When `phaseBreakdown` is provided, the email subject must read: `Decomposition Complete: {projectName} ({N} items across {M} phases)`.
4. When `phaseBreakdown` is provided, the email body must render each phase as a named section with its item count and a list of items (each showing priority and risk level).
5. Cross-phase dependencies (where a phase depends on another) must be listed in a "Cross-Phase Dependencies" section at the bottom of the email body.
6. HTML email formatting must match the existing style conventions in `gmail.ts` (same fonts, colors, spacing, wrapper structure).
7. All callers of `sendDecompositionSummary` in the codebase must be updated to pass `phaseBreakdown` where the data is available.
8. TypeScript must compile with no errors (`npx tsc --noEmit`).
9. If existing tests for the email function exist, they must continue to pass.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/decomposition-email-phase-structure
```

### Step 1: Read existing code to understand current state

Before writing any code, read the relevant files:

```bash
# Understand the PhaseBreakdown type shape
cat lib/types.ts | grep -A 40 "PhaseBreakdown\|SubPhase\|Phase"

# Understand the current email function signature, HTML structure, and callers
cat lib/gmail.ts

# Find all callers of sendDecompositionSummary
grep -rn "sendDecompositionSummary\|DecompositionSummary" --include="*.ts" --include="*.tsx" .

# Check for existing tests
find . -name "*.test.ts" | xargs grep -l "gmail\|decomposition" 2>/dev/null || echo "No tests found"
```

Take note of:
- The exact shape of `PhaseBreakdown` (fields, nested types)
- The current function signature of `sendDecompositionSummary`
- The HTML wrapper/style pattern used in other emails in `gmail.ts`
- Every call site that needs to be updated

### Step 2: Update `lib/gmail.ts`

Modify the decomposition summary function. The implementation pattern should follow this logic:

**Updated function signature:**
```typescript
export async function sendDecompositionSummary(
  projectName: string,
  workItems: WorkItem[],
  phaseBreakdown?: PhaseBreakdown  // new optional param
): Promise<void>
```

**Subject line logic:**
```typescript
const numPhases = phaseBreakdown?.phases?.length ?? 0;
const subject = numPhases > 1
  ? `Decomposition Complete: ${projectName} (${workItems.length} items across ${numPhases} phases)`
  : `Decomposition Complete: ${projectName} (${workItems.length} items)`;
```

**Body rendering logic:**

When `phaseBreakdown` is provided and has more than 1 phase, render phase sections. Otherwise render the existing flat list.

For phase-structured rendering, produce HTML like (adapt to match existing style conventions you find in `gmail.ts`):

```html
<!-- Phase sections -->
<h2 style="...">Phase A: {phaseName} ({K} items)</h2>
<!-- if phase has dependencies: -->
<p style="color: #666; font-size: 13px;">Depends on: Phase X, Phase Y</p>
<ul>
  <li>{item.title} (P{item.priority}, {item.riskLevel} risk)</li>
  ...
</ul>

<!-- Cross-phase dependencies section at bottom -->
<h2 style="...">Cross-Phase Dependencies</h2>
<ul>
  <li>Phase B depends on Phase A (items X, Y must complete first)</li>
  ...
</ul>
```

**Implementation notes:**
- Reuse whatever HTML wrapper/style object pattern already exists in `gmail.ts` — do not introduce a new pattern.
- The cross-phase dependencies section should only be rendered when at least one phase has dependencies on another phase.
- Item list entries: show `item.title`, priority (if available on WorkItem), and risk level (if available). If these fields don't exist on WorkItem, show just the title. Check `lib/types.ts` for the exact WorkItem fields.
- Match the exact field names from `PhaseBreakdown` as defined in `lib/types.ts` — do not guess.

### Step 3: Update callers

Find every call site of `sendDecompositionSummary` (from Step 1 grep) and update them to pass `phaseBreakdown` when the data is available.

The decomposer likely returns phase breakdown data — check `lib/decomposer.ts` and `lib/atc.ts`:

```bash
grep -n "sendDecompositionSummary\|phaseBreakdown\|PhaseBreakdown" lib/atc.ts lib/decomposer.ts
```

For each caller:
- If the caller has access to a `PhaseBreakdown` object (e.g., from decomposer output), pass it as the third argument.
- If the caller does not have phase data (e.g., legacy paths), leave the third argument absent — the function handles `undefined` gracefully.

### Step 4: TypeScript check and test

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues to watch for:
- `PhaseBreakdown` import missing in `gmail.ts`
- Field names on `PhaseBreakdown` or its nested types spelled incorrectly
- Optional chaining needed on `phaseBreakdown?.phases`

Run any existing tests:
```bash
npm test -- --testPathPattern="gmail|decompos" 2>/dev/null || echo "No matching tests"
npm test 2>/dev/null || echo "No test runner configured"
```

### Step 5: Build check

```bash
npm run build
```

Resolve any build errors before proceeding.

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: update decomposition summary email for phase structure

- Accept optional PhaseBreakdown param in sendDecompositionSummary
- When phases present, render phase-structured email with per-phase sections
- List cross-phase dependencies at bottom of email body
- Subject includes phase count when multiple phases exist
- No change to output when phaseBreakdown is undefined (backward compat)"

git push origin feat/decomposition-email-phase-structure

gh pr create \
  --title "feat: update decomposition summary email for phase structure" \
  --body "## Summary

Updates \`sendDecompositionSummary\` in \`lib/gmail.ts\` to render a phase-structured email when \`PhaseBreakdown\` data is available from the decomposer.

## Changes
- \`lib/gmail.ts\`: Added optional \`phaseBreakdown\` param; renders phase sections + cross-phase dependencies when present
- Updated callers (atc.ts / decomposer.ts) to pass phase breakdown where available

## Behavior
- **No phases / undefined**: email output identical to previous behavior
- **Multiple phases**: subject line includes phase count; body shows per-phase item lists and cross-phase dependency section

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- Existing tests (if any) pass"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/decomposition-email-phase-structure
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed or is unclear]
NEXT STEPS: [what remains]
```

**Common blockers and resolutions:**
- `PhaseBreakdown` type not found in `lib/types.ts` → escalate; the type may be named differently after recent refactors
- `sendDecompositionSummary` doesn't exist (function named differently) → find the actual function name via `grep -n "decomposition\|Decomposition" lib/gmail.ts` and adapt
- HTML email uses a template-string builder rather than inline HTML → follow whatever pattern exists, don't introduce a new one

**Escalation** (if blocked after 3 attempts):
```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "decomposition-email-phase-structure",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/gmail.ts"]
    }
  }'
```