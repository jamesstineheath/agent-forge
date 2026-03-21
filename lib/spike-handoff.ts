import type { WorkItem } from "./types";
import { generateSpikeTemplate } from "./spike-template";

/**
 * Generate a self-contained handoff markdown string for spike-type work items.
 * The resulting handoff instructs the executing agent to investigate a technical
 * question, fill out the spike findings template, and commit results to
 * `spikes/<workItemId>.md` — without modifying any production code.
 */
export function generateSpikeHandoff(workItem: WorkItem): string {
  if (workItem.type !== "spike" || !workItem.spikeMetadata) {
    throw new Error(
      `generateSpikeHandoff called on non-spike work item: ${workItem.id}`
    );
  }

  const meta = workItem.spikeMetadata;
  const spikeTemplate = generateSpikeTemplate(meta);
  const slug = workItem.title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50);
  const branchName = `spike/${slug}`;
  const outputPath = `spikes/${workItem.id}.md`;

  return `# Spike Investigation -- ${workItem.title}

## Metadata
- **Branch:** \`${branchName}\`
- **Priority:** ${workItem.priority}
- **Model:** sonnet
- **Type:** spike
- **Max Budget:** $${workItem.handoff?.budget ?? 5}
- **Risk Level:** ${workItem.riskLevel}
- **Estimated files:** ${outputPath}

## Context

This is a **spike investigation** — a time-boxed technical research task. The goal is to answer a specific technical question and produce a structured findings document. **No production code should be modified.**

**Parent PRD:** ${meta.parentPrdId}
**Technical Question:** ${meta.technicalQuestion}
**Scope:** ${meta.scope}
**Recommended by:** ${meta.recommendedBy}

### Work Item Details
- **Title:** ${workItem.title}
- **Description:** ${workItem.description}

## Requirements

1. Investigate the technical question: "${meta.technicalQuestion}"
2. Write findings to \`${outputPath}\` using the spike template format below
3. **DO NOT modify any production code files** — only write to the \`spikes/\` directory
4. Provide a clear recommendation: GO, GO_WITH_CHANGES, or NO_GO
5. Document what was tried, what was found, and implications for the parent PRD

## Spike Findings Template

The output file (\`${outputPath}\`) MUST use this exact structure:

\`\`\`markdown
${spikeTemplate}\`\`\`

## Execution Steps

### Step 0: Branch setup
\`\`\`bash
git checkout main && git pull
git checkout -b ${branchName}
\`\`\`

### Step 1: Create spikes directory
\`\`\`bash
mkdir -p spikes
\`\`\`

### Step 2: Investigate the technical question
Research and investigate: "${meta.technicalQuestion}"

Scope your investigation to: ${meta.scope}

Approaches to consider:
- Read relevant source code and documentation
- Check existing patterns, dependencies, and constraints
- Evaluate feasibility, risks, and trade-offs
- Consider alternative approaches

### Step 3: Write findings
Create \`${outputPath}\` using the spike findings template above. Fill in every section:
- **Parent PRD**: \`${meta.parentPrdId}\`
- **Technical Question**: The question being investigated
- **What Was Tried**: Describe your investigation approach and experiments
- **Detailed Findings**: Summarize discoveries with evidence (code snippets, links, data)
- **Recommendation**: One of GO, GO_WITH_CHANGES, or NO_GO
- **Implications for Parent PRD**: How findings affect the parent PRD

### Step 4: Verification
\`\`\`bash
# Verify the findings file exists and is non-empty
test -s ${outputPath} && echo "OK" || echo "FAIL: findings file missing or empty"
# Verify no production code was modified
git diff --name-only | grep -v '^spikes/' && echo "FAIL: production files modified" || echo "OK: only spikes/ modified"
\`\`\`

### Step 5: Commit, push, open PR
\`\`\`bash
git add spikes/
git commit -m "spike: ${workItem.title}"
git push origin ${branchName}
gh pr create --title "spike: ${workItem.title}" --body "## Spike Investigation\\n\\nInvestigates: ${meta.technicalQuestion}\\n\\nParent PRD: ${meta.parentPrdId}"
\`\`\`

## Constraints

- **DO NOT** modify any files outside the \`spikes/\` directory
- **DO NOT** install new dependencies
- **DO NOT** create or modify tests
- **DO NOT** change any configuration files
- This is a research-only task — all output goes to \`${outputPath}\`

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever findings you have so far
2. Open the PR with partial status
3. Output structured report
\`\`\`
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: ${branchName}
FILES CHANGED: [list]
SUMMARY: [what was investigated]
ISSUES: [what could not be resolved]
NEXT STEPS: [what investigation remains]
\`\`\`
`;
}
