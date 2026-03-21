/**
 * Plan progress polling: reads PLAN_STATUS.md from executing branches
 * and writes structured progress snapshots to plan records.
 */

import { getFileContent, listBranchCommits } from "@/lib/github";
import { listPlans, updatePlanProgress } from "@/lib/plans";
import type { PlanProgress } from "@/lib/types";

/**
 * Parse PLAN_STATUS.md content into a structured PlanProgress object.
 * The file format is markdown with sections like:
 * - ## Progress: X/Y criteria complete
 * - ## Current State
 * - ## Issues
 * - ## Decisions
 */
export function parsePlanStatus(content: string): Omit<PlanProgress, "commits" | "lastUpdated"> {
  let criteriaComplete = 0;
  let criteriaTotal = 0;
  let currentState = "";
  const issues: string[] = [];
  const decisions: string[] = [];

  // Parse criteria progress: look for patterns like "3/7" or "3 of 7"
  const criteriaMatch = content.match(/(\d+)\s*(?:\/|of)\s*(\d+)\s*criteria/i);
  if (criteriaMatch) {
    criteriaComplete = parseInt(criteriaMatch[1], 10);
    criteriaTotal = parseInt(criteriaMatch[2], 10);
  }

  // Also check for checkbox-style criteria: - [x] vs - [ ]
  if (criteriaTotal === 0) {
    const checked = (content.match(/- \[x\]/gi) ?? []).length;
    const unchecked = (content.match(/- \[ \]/g) ?? []).length;
    if (checked + unchecked > 0) {
      criteriaComplete = checked;
      criteriaTotal = checked + unchecked;
    }
  }

  // Parse sections
  const sections = content.split(/^## /m).filter(Boolean);
  for (const section of sections) {
    const lines = section.split("\n");
    const heading = lines[0].trim().toLowerCase();

    if (heading.startsWith("current state") || heading.startsWith("current")) {
      currentState = lines
        .slice(1)
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ")
        .slice(0, 500);
    } else if (heading.startsWith("issue")) {
      for (const line of lines.slice(1)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
          issues.push(trimmed.slice(2).trim());
        }
      }
    } else if (heading.startsWith("decision")) {
      for (const line of lines.slice(1)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
          decisions.push(trimmed.slice(2).trim());
        }
      }
    }
  }

  return { criteriaComplete, criteriaTotal, currentState, issues, decisions };
}

/**
 * Poll progress for all currently executing plans.
 * Called by the Health Monitor every 15 minutes.
 */
export async function pollPlanProgress(): Promise<{
  updated: number;
  errors: string[];
}> {
  const executingPlans = await listPlans({ status: "executing" });
  let updated = 0;
  const errors: string[] = [];

  for (const plan of executingPlans) {
    try {
      const repoFullName = plan.targetRepo.includes("/")
        ? plan.targetRepo
        : `jamesstineheath/${plan.targetRepo}`;

      // Fetch PLAN_STATUS.md from the branch
      const statusContent = await getFileContent(
        repoFullName,
        "PLAN_STATUS.md",
        plan.branchName
      );

      // Fetch commits on the branch
      const commits = await listBranchCommits(repoFullName, plan.branchName);

      if (!statusContent && commits.length === 0) {
        // No progress yet — skip but don't error
        continue;
      }

      const parsed = statusContent
        ? parsePlanStatus(statusContent)
        : { criteriaComplete: 0, criteriaTotal: 0, currentState: "", issues: [], decisions: [] };

      const progress: PlanProgress = {
        ...parsed,
        commits,
        lastUpdated: new Date().toISOString(),
      };

      await updatePlanProgress(plan.id, progress);
      updated++;
    } catch (err) {
      errors.push(`${plan.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { updated, errors };
}
