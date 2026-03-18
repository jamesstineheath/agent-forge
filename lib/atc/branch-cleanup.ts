/**
 * Branch cleanup logic — extracted to avoid circular dependencies.
 */

import { loadJson, saveJson } from "../storage";
import { listWorkItems, getWorkItem } from "../work-items";
import { listRepos, getRepo } from "../repos";
import {
  deleteBranch,
  listBranches,
  getPRByBranch,
  getBranchLastCommitDate,
} from "../github";

const ATC_BRANCH_CLEANUP_KEY = "atc/last-branch-cleanup";
const CLEANUP_THROTTLE_MINUTES = 60;
const STALE_BRANCH_HOURS = 48;
const MAX_BRANCHES_PER_REPO = 20;

export async function cleanupStaleBranches(): Promise<{
  deletedCount: number;
  skipped: number;
  errors: number;
}> {
  const now = new Date();

  // Throttle check
  const lastRun = await loadJson<{ lastRunAt: string }>(
    ATC_BRANCH_CLEANUP_KEY,
  );
  if (lastRun) {
    const elapsed =
      (now.getTime() - new Date(lastRun.lastRunAt).getTime()) / 60_000;
    if (elapsed < CLEANUP_THROTTLE_MINUTES) {
      return { deletedCount: 0, skipped: 0, errors: 0 };
    }
  }

  let deletedCount = 0;
  let skipped = 0;
  let errors = 0;

  // Phase A: Clean branches for work items in terminal/failed states
  const CLEANUP_ELIGIBLE_STATUSES = ["failed", "parked", "cancelled"] as const;
  for (const status of CLEANUP_ELIGIBLE_STATUSES) {
    const entries = await listWorkItems({ status });
    for (const entry of entries) {
      const item = await getWorkItem(entry.id);
      if (!item || !item.handoff?.branch) continue;

      if (item.execution?.prNumber != null) {
        skipped++;
        continue;
      }

      try {
        const deleted = await deleteBranch(
          item.targetRepo,
          item.handoff.branch,
        );
        if (deleted) {
          deletedCount++;
          console.log(
            `[atc] Deleted branch for ${status} work item ${item.id}: ${item.handoff.branch} from ${item.targetRepo}`,
          );
        }
      } catch {
        errors++;
      }
    }
  }

  // Phase B: Time-based stale branch cleanup
  const repoIndex = await listRepos();
  for (const repoEntry of repoIndex) {
    const repo = await getRepo(repoEntry.id);
    if (!repo) continue;

    let branches: string[];
    try {
      branches = await listBranches(repo.fullName);
    } catch {
      errors++;
      continue;
    }

    if (branches.length > MAX_BRANCHES_PER_REPO) {
      console.log(
        `[atc] ${repo.fullName} has ${branches.length} branches, capping at ${MAX_BRANCHES_PER_REPO}.`,
      );
      branches = branches.slice(0, MAX_BRANCHES_PER_REPO);
    }

    for (const branch of branches) {
      try {
        const pr = await getPRByBranch(repo.fullName, branch);
        if (pr && pr.state === "open") {
          skipped++;
          continue;
        }

        const lastCommitDate = await getBranchLastCommitDate(
          repo.fullName,
          branch,
        );
        if (!lastCommitDate) {
          skipped++;
          continue;
        }

        const ageHours =
          (now.getTime() - new Date(lastCommitDate).getTime()) / 3_600_000;
        if (ageHours < STALE_BRANCH_HOURS) {
          skipped++;
          continue;
        }

        const deleted = await deleteBranch(repo.fullName, branch);
        if (deleted) {
          deletedCount++;
          console.log(
            `[atc] Deleted stale branch: ${branch} from ${repo.fullName} (last commit: ${lastCommitDate})`,
          );
        } else {
          errors++;
        }
      } catch {
        errors++;
      }
    }
  }

  await saveJson(ATC_BRANCH_CLEANUP_KEY, { lastRunAt: now.toISOString() });

  return { deletedCount, skipped, errors };
}
