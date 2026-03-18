<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Harden Code Reviewer Prompt to Enforce TLM Memory Patterns

## Metadata
- **Branch:** `feat/harden-code-reviewer-tlm-pattern-enforcement`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** `.github/actions/tlm-review/src/review-prompt.ts`, `.github/actions/tlm-review/dist/index.js`

## Context

The TLM Code Reviewer reads `docs/tlm-memory.md` from the target repo during PR review, but currently does not enforce the hot patterns documented there. The review prompt generates a narrative review but lacks structured pattern-checking logic — PRs touching high-churn files like `lib/atc.ts` or workflow files are silently approved even when they match documented failure patterns.

The fix is entirely in `.github/actions/tlm-review/src/review-prompt.ts` (the review prompt builder) and its compiled output `.github/actions/tlm-review/dist/index.js`. No other files need modification.

Recent merged PR `chore(tlm): feedback compiler improvements (2026-03-18)` touched `.github/actions/tlm-review/src/review-prompt.ts` — review that file carefully before editing to understand current structure.

**No overlap** with concurrent work items (`handoffs/`, `app/api/agents/digest/`, `lib/digest.ts`, `vercel.json`, `scripts/`). Safe to proceed.

## Requirements

1. After reading TLM memory, the reviewer must explicitly check each hot pattern against the PR's changed files and list results in a `## Pattern Check` section.
2. For each matched hot pattern, the reviewer must provide specific justification for why the change is safe — or flag it for scrutiny. Silent approval of hot-pattern files is no longer acceptable.
3. The review comment must include a structured `## Pattern Check` section with checkbox-style entries for each pattern (matched or not).
4. If a PR matches 2+ hot patterns AND introduces non-trivial logic changes (not just additions/comments), the reviewer must call `requestChanges` instead of `approve`, asking for tests or documentation.
5. The reviewer must read the `## Lessons Learned` section of TLM memory and check if any lessons apply to the PR's domain. If the recent merge cadence is high (3+ PRs in the last hour based on available context), it must note elevated risk.
6. The compiled `dist/index.js` must be rebuilt after prompt changes (using `npm run build` or `ncc build`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/harden-code-reviewer-tlm-pattern-enforcement
```

### Step 1: Inspect current review prompt structure

```bash
cat .github/actions/tlm-review/src/review-prompt.ts
cat .github/actions/tlm-review/src/index.ts
cat .github/actions/tlm-review/package.json
```

Understand:
- How TLM memory is currently read and passed into the prompt
- The current prompt template structure (where to inject new sections)
- How the action decides to `approve` vs `requestChanges` vs `comment`
- The build command for generating `dist/index.js`

### Step 2: Update `review-prompt.ts`

The goal is to inject three new behaviours into the existing prompt:

**A. Pattern Check instruction block** — Add to the system/instruction section of the prompt. Insert after the existing TLM memory reading instructions:

```typescript
// Add this as part of the prompt template string:
const PATTERN_CHECK_INSTRUCTIONS = `
## Pattern Enforcement (MANDATORY)

After reading TLM memory, you MUST perform an explicit pattern check before writing any review content.

### Step 1: Extract Hot Patterns
From the TLM memory "Hot Patterns" section, extract:
- File names or path patterns listed as high-churn or frequently involved in issues
- Any workflow files, environment variable changes, or storage layer files flagged as risky

### Step 2: Check PR Files Against Hot Patterns
For EACH hot pattern from TLM memory, determine if the current PR touches a matching file.

### Step 3: Output Pattern Check Section
Your review comment MUST begin with (or prominently include) a "## Pattern Check" section formatted exactly as:

\`\`\`
## Pattern Check
- [x] <matched-file-or-pattern> (hot pattern: <description from TLM memory>) — <specific justification for why this change is safe OR flag: "⚠️ NEEDS SCRUTINY: <reason>">
- [ ] <unmatched-pattern> — not affected by this PR
\`\`\`

Use [x] for patterns that ARE matched by this PR's changed files.
Use [ ] for patterns that are NOT matched.

If no hot patterns are present in TLM memory, output:
\`\`\`
## Pattern Check
- [ ] No hot patterns documented in TLM memory yet
\`\`\`

### Step 4: Lessons Learned Check
From the TLM memory "Lessons Learned" section, check if any lessons apply to this PR's domain (files touched, type of change). If any apply, include a "## Lessons Applied" subsection noting which lessons are relevant.

If TLM memory notes rapid merge cadence as a risk factor, and you have evidence that multiple PRs have been merged recently (e.g., from PR descriptions or commit history), note elevated risk explicitly.

### Step 5: Approval Decision with Pattern Enforcement
Apply this decision rule:

1. Count matched hot patterns (from Step 2).
2. Assess whether the PR introduces non-trivial logic changes (new branching, state mutations, API calls) vs. pure additions (new functions with no modification to existing logic) or documentation/config changes.
3. If matched_patterns >= 2 AND non_trivial_logic_changes = true:
   → Use requestChanges with a message asking the author to add tests or documentation for the risky areas. Cite the specific hot patterns matched.
4. If matched_patterns >= 1 AND non_trivial_logic_changes = true:
   → Approve BUT include a prominent warning block in your review comment.
5. Otherwise:
   → Follow your normal approval criteria.

Your requestChanges message for case 3 should be:
"This PR matches [N] hot patterns from TLM memory ([list patterns]) and introduces non-trivial logic changes. Please add: (a) tests covering the modified logic paths, or (b) inline documentation explaining why the existing failure modes documented in TLM memory do not apply here. Once added, this can be re-reviewed."
`;
```

**B. Inject the instructions into the existing prompt builder function.** Locate the main prompt template function (likely something like `buildReviewPrompt(...)` or a similar export) and append `PATTERN_CHECK_INSTRUCTIONS` to the existing TLM memory section. Example:

```typescript
// Find the section where tlmMemory is referenced in the prompt template
// and add the pattern enforcement instructions after it. For example:

// BEFORE (approximate existing code):
`Here is the TLM memory for this repository:
<tlm_memory>
${tlmMemory}
</tlm_memory>

Please review the following PR...`

// AFTER:
`Here is the TLM memory for this repository:
<tlm_memory>
${tlmMemory}
</tlm_memory>

${PATTERN_CHECK_INSTRUCTIONS}

Please review the following PR...`
```

**C. Decision output format.** Locate where the prompt instructs the model on its output format (approve/requestChanges/comment decision). Ensure the instructions are clear that:
- `requestChanges` is appropriate (not just for broken code, but for hot-pattern violations per the rule above)
- The `## Pattern Check` section is non-optional

Add something like:

```typescript
const DECISION_FORMAT_ADDENDUM = `
## Output Format Requirements

Your response MUST be valid JSON with this structure:
{
  "decision": "approve" | "requestChanges" | "comment",
  "comment": "<full review comment in markdown, MUST include ## Pattern Check section>",
  "summary": "<one-line summary>"
}

The "comment" field must always contain a ## Pattern Check section as described above.
If you use "requestChanges", explain in the comment which hot patterns were matched and what the author should do.
`;
```

Inject this into the output format section of the prompt.

### Step 3: Handle the case where TLM memory is absent or empty

In the existing code, TLM memory may be `null`, `undefined`, or an empty string if the file doesn't exist in the target repo. Find where `tlmMemory` is used and ensure the prompt gracefully handles this:

```typescript
const tlmMemorySection = tlmMemory
  ? `Here is the TLM memory for this repository:\n<tlm_memory>\n${tlmMemory}\n</tlm_memory>`
  : `No TLM memory file found for this repository. Skip the Pattern Check enforcement (output "## Pattern Check\n- [ ] No TLM memory available") and proceed with standard review.`;
```

### Step 4: Build the compiled output

```bash
cd .github/actions/tlm-review
npm install
npm run build
```

If `npm run build` doesn't exist, check `package.json` for the correct build command. Common patterns:
```bash
# Check what's available:
cat package.json | grep -A 10 '"scripts"'

# Likely one of:
npx @vercel/ncc build src/index.ts -o dist
# or
npm run build
# or
npx tsc
```

The compiled `dist/index.js` must be updated — GitHub Actions runs the compiled output, not the TypeScript source.

### Step 5: Verify TypeScript compiles cleanly

```bash
cd .github/actions/tlm-review
npx tsc --noEmit
```

Fix any type errors before proceeding.

### Step 6: Sanity check the dist output

```bash
# Verify the dist/index.js was updated (timestamp or content check)
ls -la dist/index.js

# Grep for key new strings in the compiled output to confirm injection worked
grep -c "Pattern Check" dist/index.js
grep -c "requestChanges" dist/index.js
grep -c "hot pattern" dist/index.js
```

All three should return counts > 0.

### Step 7: Verify no other files were accidentally modified

```bash
git diff --name-only
```

Expected output should only include:
```
.github/actions/tlm-review/src/review-prompt.ts
.github/actions/tlm-review/dist/index.js
```

If `package-lock.json` or `node_modules` drift shows up, exclude from commit with `.gitignore` or `git restore`.

### Step 8: Commit, push, open PR

```bash
git add .github/actions/tlm-review/src/review-prompt.ts
git add .github/actions/tlm-review/dist/index.js
git commit -m "feat(tlm-review): enforce TLM memory hot patterns in code review

- Add mandatory Pattern Check section to every review comment
- Reviewer must cite each hot pattern and explain safety or flag for scrutiny
- If PR matches 2+ hot patterns with non-trivial logic changes, use requestChanges
- Add Lessons Learned check against PR domain
- Note elevated risk when rapid merge cadence is detected
- Pattern Check output is structured checkbox format for traceability"

git push origin feat/harden-code-reviewer-tlm-pattern-enforcement

gh pr create \
  --title "feat(tlm-review): harden code reviewer to enforce TLM memory hot patterns" \
  --body "## Summary
Updates the TLM Code Reviewer prompt to actively enforce documented hot patterns from \`docs/tlm-memory.md\` rather than silently approving PRs that match known failure patterns.

## Changes
- \`.github/actions/tlm-review/src/review-prompt.ts\`: Added pattern enforcement instructions, structured Pattern Check output format, and decision rule for requesting changes on multi-pattern matches
- \`.github/actions/tlm-review/dist/index.js\`: Rebuilt compiled action output

## New Reviewer Behaviour
1. **Pattern Check section** — every review comment now includes a \`## Pattern Check\` section with checkbox entries for each hot pattern
2. **Mandatory justification** — matched hot patterns require explicit safety justification, not silent approval
3. **Request changes threshold** — 2+ matched hot patterns + non-trivial logic changes → \`requestChanges\` with specific remediation ask
4. **Lessons Learned** — reviewer checks if documented lessons apply to the PR's domain
5. **Merge cadence awareness** — notes elevated risk if rapid merge cadence is detected

## Acceptance Criteria
- [x] Review comments include \`## Pattern Check\` section
- [x] Hot-pattern file touches get explicit justification
- [x] \`requestChanges\` triggered for high-risk multi-pattern PRs
- [ ] \"caused issues\" rate declining within 2 weeks (observable via TLM memory updates)

## Risk
Medium — changes only the review prompt text and compiled action. No changes to control plane logic, storage, or API routes. Worst case: reviewer is overly strict on a PR; human override available."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/harden-code-reviewer-tlm-pattern-enforcement
FILES CHANGED: [list from git diff --name-only]
SUMMARY: [what was done]
ISSUES: [what failed — e.g., "build failed with ncc error: ...", "could not locate buildReviewPrompt function"]
NEXT STEPS: [e.g., "manually locate prompt template injection point in review-prompt.ts and apply PATTERN_CHECK_INSTRUCTIONS", "re-run ncc build after fixing"]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve (e.g., the `review-prompt.ts` structure is radically different from what's described, the build system is broken, or the action uses a different mechanism to pass TLM memory to Claude):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "harden-code-reviewer-tlm-pattern-enforcement",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or structural mismatch description>",
      "filesChanged": [".github/actions/tlm-review/src/review-prompt.ts"]
    }
  }'
```

## Notes for Executor

- **Read `review-prompt.ts` carefully first** — the exact function names, template literal structure, and how `tlmMemory` is threaded through will determine exactly where to inject the new instructions. Don't assume — inspect before editing.
- **The dist rebuild is mandatory.** GitHub Actions executes `dist/index.js`, not the TypeScript source. A prompt change without rebuilding dist will have zero effect in production.
- **Do not modify** `vercel.json`, `lib/digest.ts`, `app/api/agents/digest/`, `scripts/`, or any handoff files — those belong to concurrent work items.
- If the build tool is `@vercel/ncc`, the command is typically: `npx @vercel/ncc build src/index.ts -o dist --license licenses.txt`
- The prompt additions should be self-contained string constants — avoid restructuring the existing function signatures to minimize merge conflict risk.