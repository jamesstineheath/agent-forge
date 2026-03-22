import type { Plan } from "./types";
import { generateSpikeTemplate } from "./spike-template";

/**
 * Generate the prompt that Claude Code CLI will execute for a plan.
 * This replaces handoff files — the prompt contains all acceptance criteria
 * and context needed to implement the full PRD scope.
 *
 * For spike plans, delegates to generateSpikePlanPrompt() which produces
 * a findings-only investigation prompt.
 */
export function generatePlanPrompt(plan: Plan): string {
  if (plan.prdType === "spike") {
    return generateSpikePlanPrompt(plan);
  }
  const sections: string[] = [];

  // Header
  sections.push(`# PRD Execution: ${plan.prdTitle}`);
  sections.push(`**Branch:** \`${plan.branchName}\``);
  sections.push(`**Budget:** $${plan.estimatedBudget ?? 10}`);
  sections.push(`**Max Duration:** ${plan.maxDurationMinutes} minutes`);
  sections.push("");

  // Acceptance Criteria
  sections.push("## Acceptance Criteria");
  sections.push("");
  sections.push(plan.acceptanceCriteria);
  sections.push("");

  // KG Context
  if (plan.kgContext) {
    sections.push("## Codebase Context (from Knowledge Graph)");
    sections.push("");

    if (plan.kgContext.affectedFiles.length > 0) {
      sections.push("### Affected Files");
      sections.push("These files are likely relevant to this PRD based on knowledge graph analysis:");
      sections.push(plan.kgContext.affectedFiles.map(f => `- \`${f}\``).join("\n"));
      sections.push("");
    }

    if (plan.kgContext.systemMapSections) {
      sections.push("### System Map (relevant sections)");
      sections.push(plan.kgContext.systemMapSections);
      sections.push("");
    }

    if (plan.kgContext.relevantADRs.length > 0) {
      sections.push("### Relevant ADRs");
      for (const adr of plan.kgContext.relevantADRs) {
        sections.push(`- **${adr.title}** (${adr.status}): ${adr.decision}`);
      }
      sections.push("");
    }
  }

  // Execution constraints
  sections.push("## Execution Constraints");
  sections.push("");
  sections.push("1. **Commit incrementally** — after each acceptance criterion or significant change, commit with a descriptive message.");
  sections.push("2. **Run type checks** — run `tsc --noEmit` after each major change. Fix any type errors before proceeding.");
  sections.push("3. **Run tests** — run `npm test` before the final push. CI will reject failing tests.");
  sections.push("4. **Push to branch** — push all commits to the branch when done.");
  sections.push("5. **Open a PR** — create a PR against main using `gh pr create`. GITHUB_TOKEN is available.");
  sections.push("6. **Do not skip verification steps.** If build fails after 3 attempts, stop and push what you have.");
  sections.push("");

  // Session memory
  sections.push("## Session Memory (PLAN_STATUS.md)");
  sections.push("");
  sections.push("Maintain a `PLAN_STATUS.md` file at the repo root throughout execution:");
  sections.push("- **Before starting:** Check if `PLAN_STATUS.md` exists on the branch (from a previous attempt). If it does, read it to understand prior progress and continue from where it left off.");
  sections.push("- **After each criterion:** Update PLAN_STATUS.md with progress, decisions made, and any issues encountered.");
  sections.push("- **Before opening the PR:** Remove PLAN_STATUS.md in a cleanup commit.");
  sections.push("");
  sections.push("PLAN_STATUS.md format:");
  sections.push("```markdown");
  sections.push("# Plan Execution Status");
  sections.push("## Progress");
  sections.push("- [x] AC-1: (description) — completed");
  sections.push("- [ ] AC-2: (description) — in progress");
  sections.push("## Decisions");
  sections.push("- (key decisions made during execution)");
  sections.push("## Issues");
  sections.push("- (any blockers or issues encountered)");
  sections.push("```");

  return sections.join("\n");
}

/**
 * Generate a spike-specific plan prompt that instructs Claude Code to
 * investigate a technical question and produce a structured findings document
 * instead of functional code changes.
 */
export function generateSpikePlanPrompt(plan: Plan): string {
  const meta = plan.spikeMetadata;
  const outputPath = `spikes/${plan.prdId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.md`;
  const spikeTemplate = meta
    ? generateSpikeTemplate(meta)
    : generateSpikeTemplate({
        parentPrdId: plan.prdId,
        technicalQuestion: plan.prdTitle,
        scope: plan.acceptanceCriteria.slice(0, 200),
        recommendedBy: "manual",
      });

  const sections: string[] = [];

  // Header
  sections.push(`# Spike Investigation: ${plan.prdTitle}`);
  sections.push("");
  sections.push(`**Branch:** \`${plan.branchName}\``);
  sections.push(`**Budget:** $${plan.estimatedBudget ?? 3}`);
  sections.push(`**Max Duration:** ${plan.maxDurationMinutes} minutes`);
  sections.push(`**Type:** spike (findings only — no production code)`);
  sections.push("");

  // Context
  sections.push("## Context");
  sections.push("");
  sections.push("This is a **spike investigation** — a time-boxed technical research task.");
  sections.push("The goal is to answer a specific technical question and produce a structured findings document.");
  sections.push("**No production code should be modified.** Only write to the `spikes/` directory.");
  sections.push("");

  if (meta) {
    sections.push(`**Parent PRD:** ${meta.parentPrdId}`);
    sections.push(`**Technical Question:** ${meta.technicalQuestion}`);
    sections.push(`**Scope:** ${meta.scope}`);
    sections.push("");
  }

  // PRD content (the acceptance criteria text contains the spike's investigation scope)
  sections.push("## Investigation Scope");
  sections.push("");
  sections.push(plan.acceptanceCriteria);
  sections.push("");

  // KG Context (reuse standard logic)
  if (plan.kgContext) {
    sections.push("## Codebase Context (from Knowledge Graph)");
    sections.push("");
    if (plan.kgContext.affectedFiles.length > 0) {
      sections.push("### Relevant Files");
      sections.push(plan.kgContext.affectedFiles.map(f => `- \`${f}\``).join("\n"));
      sections.push("");
    }
    if (plan.kgContext.relevantADRs.length > 0) {
      sections.push("### Relevant ADRs");
      for (const adr of plan.kgContext.relevantADRs) {
        sections.push(`- **${adr.title}** (${adr.status}): ${adr.decision}`);
      }
      sections.push("");
    }
  }

  // Spike findings template
  sections.push("## Output: Spike Findings Document");
  sections.push("");
  sections.push(`Write findings to \`${outputPath}\` using this exact structure:`);
  sections.push("");
  sections.push("```markdown");
  sections.push(spikeTemplate);
  sections.push("```");
  sections.push("");

  // Execution steps
  sections.push("## Execution Steps");
  sections.push("");
  sections.push("### Step 1: Create spikes directory");
  sections.push("```bash");
  sections.push("mkdir -p spikes");
  sections.push("```");
  sections.push("");
  sections.push("### Step 2: Investigate the technical question");
  sections.push("Research and investigate the question. Approaches to consider:");
  sections.push("- Read relevant source code and documentation");
  sections.push("- Check existing patterns, dependencies, and constraints");
  sections.push("- Attempt proof-of-concept code (but do not commit it outside `spikes/`)");
  sections.push("- Evaluate feasibility, risks, and trade-offs");
  sections.push("- Consider alternative approaches");
  sections.push("");
  sections.push(`### Step 3: Write findings to \`${outputPath}\``);
  sections.push("Fill in every section of the template above. Provide a clear recommendation:");
  sections.push("- **GO**: Feasible. Describe the recommended approach.");
  sections.push("- **GO_WITH_CHANGES**: Feasible but the PRD needs redesign. Describe what changes.");
  sections.push("- **NO_GO**: Not feasible. Explain why and suggest alternatives if any.");
  sections.push("");
  sections.push("### Step 4: Verification");
  sections.push("```bash");
  sections.push(`test -s ${outputPath} && echo "OK" || echo "FAIL: findings file missing or empty"`);
  sections.push('git diff --name-only | grep -v "^spikes/" && echo "FAIL: production files modified" || echo "OK: only spikes/ modified"');
  sections.push("```");
  sections.push("");
  sections.push("### Step 5: Commit, push, open PR");
  sections.push("```bash");
  sections.push("git add spikes/");
  sections.push(`git commit -m "spike: ${plan.prdTitle}"`);
  sections.push(`git push origin ${plan.branchName}`);
  sections.push(`gh pr create --title "spike: ${plan.prdTitle}" --body "Spike investigation for ${plan.prdId}"`);
  sections.push("```");
  sections.push("");

  // Constraints
  sections.push("## Constraints");
  sections.push("");
  sections.push("- **DO NOT** modify any files outside the `spikes/` directory");
  sections.push("- **DO NOT** install new dependencies");
  sections.push("- **DO NOT** create or modify tests");
  sections.push("- **DO NOT** change any configuration files");
  sections.push(`- All output goes to \`${outputPath}\``);
  sections.push("");

  // Abort protocol
  sections.push("## Session Abort Protocol");
  sections.push("If running low on context or hitting unresolvable errors:");
  sections.push("1. Commit and push whatever findings you have so far");
  sections.push("2. Open the PR with partial status");
  sections.push("3. Output structured report:");
  sections.push("```");
  sections.push("STATUS: [PR Open | Failed | Blocked]");
  sections.push("PR: [URL or none]");
  sections.push(`BRANCH: ${plan.branchName}`);
  sections.push("FILES CHANGED: [list]");
  sections.push("SUMMARY: [what was investigated]");
  sections.push("ISSUES: [what could not be resolved]");
  sections.push("NEXT STEPS: [what investigation remains]");
  sections.push("```");

  return sections.join("\n");
}
