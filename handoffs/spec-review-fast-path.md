# Handoff: Spec Review Fast-Path for Low-Risk Handoffs

Max Budget: $4 | Model: opus | Risk: low

## Context

Every handoff currently goes through the full TLM Spec Review, which calls the Claude API (Opus model, ~16k max tokens) to analyze the handoff and potentially rewrite it. This adds 1-2 minutes of latency to every pipeline run. For low-risk, small-budget handoffs (simple bug fixes, config changes, single-file modifications), the spec review rarely makes meaningful improvements but still costs time and API credits.

This handoff adds a fast-path check at the beginning of the spec review action. If the handoff metadata indicates `Risk: low` AND `Max Budget` is $3 or less, the action logs a skip message and exits successfully without calling the Claude API. The workflow still "completes" with success, which triggers the Execute Handoff workflow downstream as normal.

## Pre-flight Self-check

- [ ] Read `.github/actions/tlm-spec-review/src/index.ts` fully
- [ ] Read `.github/actions/tlm-spec-review/action.yml`
- [ ] Read `.github/actions/tlm-spec-review/package.json` for build/bundle commands
- [ ] Verify the workflow chain: `tlm-spec-review.yml` triggers on push to `handoffs/**`, execute-handoff triggers on spec review workflow completion
- [ ] Run the action's build command to confirm dist is current

## Step 0: Branch + Commit Setup

Branch: `fix/spec-review-fast-path` (already created)
Base: `main`

## Step 1: Add Fast-Path Metadata Parser

In `.github/actions/tlm-spec-review/src/index.ts`, add a helper function before the `run()` function:

```typescript
interface HandoffMetadata {
  risk: string | null;
  budget: number | null;
}

function parseHandoffMetadata(content: string): HandoffMetadata {
  // Parse risk level: "Risk: low" or "Risk: low" in metadata line
  const riskMatch = content.match(/Risk:\s*(low|medium|high)/i);
  const risk = riskMatch ? riskMatch[1].toLowerCase() : null;

  // Parse budget: "Max Budget: $3" or "Budget: $5"
  const budgetMatch = content.match(/(?:Max\s+)?Budget:\s*\$([\d.]+)/i);
  const budget = budgetMatch ? parseFloat(budgetMatch[1]) : null;

  return { risk, budget };
}

function isLowRiskFastPath(metadata: HandoffMetadata): boolean {
  return metadata.risk === "low" && metadata.budget !== null && metadata.budget <= 3;
}
```

## Step 2: Add Fast-Path Check in Review Loop

In the `run()` function, inside the `for (const handoffPath of handoffFiles)` loop, right after the `handoffContent` is read (after the null check), add the fast-path check:

```typescript
// Fast-path: skip full spec review for low-risk, low-budget handoffs
const metadata = parseHandoffMetadata(handoffContent);
if (isLowRiskFastPath(metadata)) {
  core.info(`Fast-path: skipping spec review for low-risk handoff (risk=${metadata.risk}, budget=$${metadata.budget}): ${handoffPath}`);

  // Post a brief comment on the PR if one exists
  if (prNumber) {
    try {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: [
          `## TLM Spec Review: FAST-PATH \u26A1`,
          "",
          `**${handoffPath}**`,
          "",
          `Skipped full review (risk: ${metadata.risk}, budget: $${metadata.budget}). Proceeding directly to execution.`,
          "",
          "<!--",
          "TLM-SPEC-REVIEW",
          "decision: FAST_PATH",
          "improved: false",
          `changes_summary: Skipped - low risk ($${metadata.budget} budget)`,
          "flagged_risks: none",
          "-->",
        ].join("\n"),
      });
    } catch (commentErr) {
      core.warning(`Failed to post fast-path comment: ${commentErr}`);
    }
  }
  continue; // Skip to next handoff file
}
```

This `continue` skips the Claude API call for this file. The workflow still exits successfully, triggering execute-handoff.

## Step 3: Rebuild the Action Bundle

The action uses a bundled `dist/` directory. After making changes to `src/index.ts`:

```bash
cd .github/actions/tlm-spec-review
npm install
npm run build
```

Verify that `dist/index.js` was updated by checking its modification timestamp. Commit the updated `dist/` along with the source changes.

## Step 4: Verification

- The action builds without errors (`npm run build` in the action directory)
- `npx tsc --noEmit` passes in the action directory (or no tsconfig errors)
- Read through the fast-path logic: confirm it only skips when BOTH conditions are met (risk=low AND budget<=$3)
- Verify the `continue` statement is inside the handoff file loop, not the outer function
- Confirm `dist/index.js` is updated and committed

## Abort Protocol

If the action build fails, check the tsconfig and package.json for the correct build command. If the dist bundle fails to generate, ship only the source changes and note in the PR that dist needs to be rebuilt manually. The action will still work with the old dist until rebuilt.
