# Agent Forge -- Create Spike Handoff Generator and Execution Template

## Metadata
- **Branch:** `feat/spike-handoff-generator`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/spike-handoff.ts, handoffs/templates/spike-execution.md, lib/orchestrator.ts

## Context

Agent Forge already has spike work item support in the data layer (schema, types, CRUD) and a spike findings template/parser utility in `lib/spike-template.ts`. The next step is to close the loop on the execution side: when the Orchestrator dispatches a spike-type work item, it should generate a handoff file that instructs Claude Code to investigate a technical question and write findings — without touching production code.

Key existing files to understand before implementing:
- `lib/spike-template.ts` — exports the spike findings template structure and parser
- `lib/orchestrator.ts` — the main handoff generation + dispatch pipeline; needs a routing branch for `type === 'spike'`
- `lib/types.ts` — `WorkItem` type definition including `type` and `spikeMetadata` fields (added in recent PR)
- `lib/work-items.ts` — CRUD for work items, including spike fields

The spike handoff generator must produce a self-contained handoff string that:
1. Directs Claude Code to create `spikes/` directory if absent
2. Uses the spike template from `lib/spike-template.ts` as the output format
3. Commits findings to `spikes/<work-item-id>.md`
4. Explicitly prohibits touching any production code

## Requirements

1. `lib/spike-handoff.ts` exports a `generateSpikeHandoff(workItem: WorkItem): string` function that returns a complete handoff markdown string for spike-type work items
2. The generated handoff includes the spike template structure (sourced from `lib/spike-template.ts`) so the executing agent knows exactly what to fill in
3. The generated handoff explicitly instructs the agent NOT to modify production code files (only write to `spikes/` directory)
4. The generated handoff directs the agent to: create `spikes/` if missing, investigate the technical question from `workItem.spikeMetadata`, fill the template, commit to `spikes/<workItem.id>.md`
5. `lib/orchestrator.ts` detects `workItem.type === 'spike'` and routes to `generateSpikeHandoff()` instead of the normal handoff generation path
6. `handoffs/templates/spike-execution.md` exists and documents the spike execution protocol (what spike handoffs do, what agents must/must not do, output format)
7. TypeScript compiles without errors (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/spike-handoff-generator
```

### Step 1: Inspect existing spike-related files

Read these files to understand what already exists before writing any code:

```bash
cat lib/spike-template.ts
cat lib/types.ts
cat lib/orchestrator.ts
```

Key things to extract:
- The exact shape of `WorkItem` (especially `type`, `spikeMetadata`, `id`, `title`, `description` fields)
- What `lib/spike-template.ts` exports — the template string and any helper types
- How `lib/orchestrator.ts` currently generates handoffs — find the main generation function and its call site

### Step 2: Create `lib/spike-handoff.ts`

Create the file with the following structure (adapt field names to match actual `WorkItem` type):

```typescript
import { WorkItem } from './types';
import { getSpikeTemplate } from './spike-template'; // adjust import to match actual exports

/**
 * Generates a handoff file for spike-type work items.
 * The handoff instructs Claude Code to investigate a technical question
 * and write findings to spikes/<work-item-id>.md.
 * Production code must NOT be modified.
 */
export function generateSpikeHandoff(workItem: WorkItem): string {
  const spikeMetadata = workItem.spikeMetadata ?? {};
  const question = spikeMetadata.question ?? workItem.description ?? 'Investigate the technical question described in the work item.';
  const hypothesis = spikeMetadata.hypothesis ?? '';
  const constraints = spikeMetadata.constraints ?? '';
  const successCriteria = spikeMetadata.successCriteria ?? workItem.acceptanceCriteria ?? '';

  // Get the spike findings template structure so the agent knows the output format
  const templateContent = getSpikeTemplate(); // adjust call signature to match actual export

  const outputPath = `spikes/${workItem.id}.md`;

  return `# Spike: ${workItem.title}

## ⚠️ CRITICAL CONSTRAINT — READ FIRST

**This is a spike (research/investigation) work item. You MUST NOT modify any production code.**

Specifically prohibited:
- Do NOT edit any \`.ts\`, \`.tsx\`, \`.js\`, \`.jsx\`, or any source files outside the \`spikes/\` directory
- Do NOT modify \`package.json\`, \`tsconfig.json\`, or any config files
- Do NOT change any files in \`lib/\`, \`app/\`, \`components/\`, \`.github/\`, or any other source directory
- The ONLY file you may create or modify is \`${outputPath}\`

Your sole deliverable is a written findings document at \`${outputPath}\`.

---

## Metadata
- **Work Item ID:** ${workItem.id}
- **Type:** spike
- **Priority:** ${workItem.priority ?? 'medium'}

## Spike Context

### Technical Question
${question}

${hypothesis ? `### Hypothesis\n${hypothesis}\n` : ''}
${constraints ? `### Constraints / Boundaries\n${constraints}\n` : ''}
${successCriteria ? `### Success Criteria\n${successCriteria}\n` : ''}

---

## Execution Steps

### Step 0: Create spikes/ directory if it doesn't exist
\`\`\`bash
mkdir -p spikes
\`\`\`

### Step 1: Investigate the technical question

Conduct your investigation using only:
- Reading existing source files in this repository (read-only)
- Searching documentation, code comments, and configuration
- Reasoning about tradeoffs, architecture, and implementation options
- Reviewing existing ADRs in \`docs/adr/\`
- Reading \`CLAUDE.md\` and \`docs/SYSTEM_MAP.md\` for context

Do NOT make any code changes. Do NOT run builds or tests that would modify files.

### Step 2: Write findings to \`${outputPath}\`

Use the spike findings template below as your output format. Fill in every section based on your investigation.

**Template to fill in:**

\`\`\`markdown
${templateContent}
\`\`\`

Write your completed findings document to \`${outputPath}\`.

### Step 3: Commit the findings
\`\`\`bash
git add ${outputPath}
git commit -m "spike: findings for ${workItem.id} — ${workItem.title}"
git push origin $(git branch --show-current)
\`\`\`

### Step 4: Open a PR
\`\`\`bash
gh pr create \\
  --title "spike: ${workItem.title}" \\
  --body "Spike investigation findings for work item ${workItem.id}.

## Summary
$(echo "${question}" | head -c 200)

## Output
Findings written to \`${outputPath}\`.

## ⚠️ No production code was modified in this spike."
\`\`\`

---

## Session Abort Protocol

If you cannot complete the investigation:
1. Write partial findings with whatever you have discovered so far
2. Mark incomplete sections clearly with \`[INCOMPLETE]\`
3. Commit and push the partial findings
4. Open the PR with partial status

\`\`\`
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: [branch-name]
FILES CHANGED: [spikes/${workItem.id}.md]
SUMMARY: [what was investigated]
ISSUES: [what could not be resolved]
NEXT STEPS: [what remains for the spike]
\`\`\`
`;
}
```

**Important:** After reading `lib/spike-template.ts`, adjust:
- The import name and call signature for the template function to match what is actually exported
- The `spikeMetadata` field names to match the actual `WorkItem` type definition
- The `acceptanceCriteria` field name if it differs in `WorkItem`

### Step 3: Create `handoffs/templates/spike-execution.md`

```bash
mkdir -p handoffs/templates
```

Create `handoffs/templates/spike-execution.md`:

````markdown
# Spike Execution Protocol

## Overview

A **spike** is a time-boxed investigation into a technical question. Spikes produce written findings — not code changes. They inform future work items that will implement actual changes.

Agent Forge uses spikes when a work item requires research before implementation can be scoped or estimated.

## What Spike Handoffs Do

When the Orchestrator dispatches a spike-type work item, it generates a specialized handoff via `lib/spike-handoff.ts`. This handoff:

1. States the technical question from `spikeMetadata`
2. Provides the spike findings template as the required output format
3. Directs the agent to write findings to `spikes/<work-item-id>.md`
4. Explicitly prohibits any production code modifications
5. Instructs the agent to open a PR with the findings document

## Agent Obligations

### ✅ MUST DO
- Create `spikes/` directory if it doesn't exist
- Read existing code, ADRs, and documentation to inform the investigation
- Fill in every section of the spike findings template
- Write the completed findings to `spikes/<work-item-id>.md`
- Commit and push the findings document
- Open a PR summarizing the investigation

### ❌ MUST NOT DO
- Modify any `.ts`, `.tsx`, `.js`, `.jsx`, or other source files
- Edit `package.json`, `tsconfig.json`, or any configuration
- Change anything in `lib/`, `app/`, `components/`, `.github/`, or other source directories
- Run commands that produce build artifacts or modify lockfiles
- Implement any production code changes — even if the answer to the spike is obvious

## Output Format

All spike findings are written using the template defined in `lib/spike-template.ts`. The template includes:

- **Question**: The technical question being investigated
- **Context**: Background and motivation
- **Investigation**: What was explored and how
- **Findings**: What was discovered
- **Recommendation**: Suggested next steps or approach
- **Risks / Tradeoffs**: Known concerns
- **Follow-up Work Items**: Concrete implementation tasks that should be filed as a result

## Output Location

Findings are always written to:
```
spikes/<work-item-id>.md
```

The `spikes/` directory is version-controlled but contains only investigation documents, never production code.

## Routing in Orchestrator

`lib/orchestrator.ts` detects `workItem.type === 'spike'` and calls `generateSpikeHandoff(workItem)` from `lib/spike-handoff.ts` instead of the standard handoff generation path.

## Lifecycle

```
Spike work item filed (type: 'spike')
        ↓
Orchestrator detects type === 'spike'
        ↓
generateSpikeHandoff() generates specialized handoff
        ↓
Execute Handoff: agent investigates, writes spikes/<id>.md
        ↓
PR opened with findings document
        ↓
TLM Code Review (validates no production code modified, findings complete)
        ↓
Merged → findings available for follow-up work items
```

## Example

For a spike work item with ID `wi_abc123` and title "Investigate Inngest vs BullMQ for job queuing":

- Handoff instructs agent to investigate the question from `spikeMetadata.question`
- Agent reads codebase, ADRs, and reasons about tradeoffs
- Agent writes findings to `spikes/wi_abc123.md`
- PR opened: "spike: Investigate Inngest vs BullMQ for job queuing"
- No production files are modified
````

### Step 4: Modify `lib/orchestrator.ts` to route spike work items

Read `lib/orchestrator.ts` carefully. Find the function responsible for generating the handoff content (likely something like `generateHandoff`, `buildHandoff`, or the main orchestration function that returns or writes the handoff string).

Add the routing logic. The pattern to apply:

```typescript
// At the top of orchestrator.ts, add import:
import { generateSpikeHandoff } from './spike-handoff';

// Inside the handoff generation function, before the normal generation path:
// (adapt to match the actual function signature and parameter names)

if (workItem.type === 'spike') {
  return generateSpikeHandoff(workItem);
}

// ... rest of existing handoff generation logic
```

**Be careful:**
- Find the exact location where the handoff content string is generated/returned, not where it's committed or pushed
- If there are multiple paths (e.g., different repo types), add the spike check at the earliest common point before branching
- Do not refactor any existing logic — only add the import and the early-return guard

### Step 5: Verification

```bash
# Check TypeScript compiles
npx tsc --noEmit

# Verify files exist
ls -la lib/spike-handoff.ts
ls -la handoffs/templates/spike-execution.md

# Quick smoke check: verify the export is correct
node -e "const { generateSpikeHandoff } = require('./lib/spike-handoff'); console.log(typeof generateSpikeHandoff);"

# Run any existing tests
npm test 2>/dev/null || echo "no test runner configured"
```

If `tsc` reports errors, fix them before proceeding. Common issues:
- `spikeMetadata` fields not matching the actual `WorkItem` type — read `lib/types.ts` again and correct field names
- Import path for `spike-template.ts` exports — match exactly what is exported
- `getSpikeTemplate` call signature — match the actual function signature (may take arguments or none)

### Step 6: Commit, push, open PR

```bash
git add lib/spike-handoff.ts handoffs/templates/spike-execution.md lib/orchestrator.ts
git commit -m "feat: add spike handoff generator and execution template

- Add lib/spike-handoff.ts with generateSpikeHandoff(workItem) function
- Add handoffs/templates/spike-execution.md documenting spike protocol
- Modify lib/orchestrator.ts to route type=spike work items to spike handoff generator
- Spike handoffs explicitly prohibit production code modifications
- Spike findings written to spikes/<work-item-id>.md"
git push origin feat/spike-handoff-generator

gh pr create \
  --title "feat: spike handoff generator and execution template" \
  --body "## Summary

Closes the loop on spike work item support by adding the execution-side infrastructure.

## Changes

### \`lib/spike-handoff.ts\` (new)
- Exports \`generateSpikeHandoff(workItem: WorkItem): string\`
- Generates a complete handoff markdown string for spike investigations
- Embeds the spike findings template from \`lib/spike-template.ts\`
- Explicitly prohibits production code modifications
- Directs agent to write to \`spikes/<work-item-id>.md\`

### \`handoffs/templates/spike-execution.md\` (new)
- Documents the spike execution protocol
- Describes agent obligations (must/must not)
- Explains the routing logic and output format
- Reference document for the spike lifecycle

### \`lib/orchestrator.ts\` (modified)
- Detects \`workItem.type === 'spike'\`
- Routes to \`generateSpikeHandoff()\` instead of normal handoff generation

## Testing
- \`npx tsc --noEmit\` passes
- Spike handoffs are self-contained and instruct agents correctly

## Related
- Builds on: spike type support in schema/types/CRUD (previous PRs)
- Builds on: \`lib/spike-template.ts\` (spike findings template)
- Enables: Orchestrator to dispatch spike work items end-to-end"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/spike-handoff-generator
FILES CHANGED: [list of what was created/modified]
SUMMARY: [what was implemented]
ISSUES: [what failed or was left incomplete]
NEXT STEPS: [what remains — e.g., "orchestrator routing not wired, tsc errors on spikeMetadata fields"]
```

## Escalation

If blocked on ambiguous `WorkItem` type shape, missing exports from `lib/spike-template.ts`, or unclear orchestrator routing point after 3 attempts:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "spike-handoff-generator",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker>",
      "filesChanged": ["lib/spike-handoff.ts", "handoffs/templates/spike-execution.md", "lib/orchestrator.ts"]
    }
  }'
```