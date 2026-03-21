/**
 * Shared bug helpers for Notion Bugs DB integration.
 * Used by AC-3 (dispatcher), AC-4, AC-5, and AC-6.
 */
import {
  queryTriagedBugs as notionQueryTriagedBugs,
  updateBugWorkItemId,
  updateBugStatus,
  type NotionBug,
} from "./notion";

export type { NotionBug };

export const BUGS_DATABASE_ID = "023f3621-2885-468d-a8cf-2e0bd1458bb3";

export type BugSeverity = NotionBug["severity"];

export interface TriagedBug {
  id: string;          // Notion page ID
  title: string;
  severity: BugSeverity;
  context: string;
  affectedFiles: string[];
  targetRepo: string;
  createdTime: string; // ISO timestamp
  workItemId: string | null;
}

const SEVERITY_ORDER: Record<BugSeverity, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

/**
 * Query the Bugs database for pages with Status="Triaged".
 * Returns structured bug objects sorted by severity (Critical first), then oldest first.
 */
export async function queryTriagedBugs(): Promise<TriagedBug[]> {
  const notionBugs = await notionQueryTriagedBugs();

  const bugs: TriagedBug[] = notionBugs.map((nb) => ({
    id: nb.pageId,
    title: nb.title,
    severity: nb.severity,
    context: nb.context,
    affectedFiles: nb.affectedFiles,
    targetRepo: nb.targetRepo ?? "agent-forge",
    createdTime: nb.createdTime,
    workItemId: nb.workItemId,
  }));

  bugs.sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return new Date(a.createdTime).getTime() - new Date(b.createdTime).getTime();
  });

  return bugs;
}

/**
 * Update a Notion bug page: set Work Item ID and transition Status to "In Progress".
 */
export async function updateBugPage(
  pageId: string,
  workItemId: string,
): Promise<void> {
  await updateBugWorkItemId(pageId, workItemId);
  await updateBugStatus(pageId, "In Progress");
}
