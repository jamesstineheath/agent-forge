import type { Plan } from "./types";

/**
 * Generate the prompt that Claude Code CLI will execute for a plan.
 * This replaces handoff files — the prompt contains all acceptance criteria
 * and context needed to implement the full PRD scope.
 */
export function generatePlanPrompt(plan: Plan): string {
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
