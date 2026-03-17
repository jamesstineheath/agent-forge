import { appendPageContent, queryProjects, updateProjectStatus } from "./notion";
import type { Project, ProjectStatus, WorkItem } from "./types";
import { getWorkItem, listWorkItems } from "./work-items";

export const TERMINAL_STATES = ['merged', 'parked', 'cancelled', 'failed'] as const;
type TerminalState = typeof TERMINAL_STATES[number];

function isTerminalState(status: string): status is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(status);
}

export async function checkProjectCompletion(
  projectId: string,
  workItems: WorkItem[]
): Promise<{ isTerminal: boolean; status: 'Complete' | 'Failed' | null; summary: string }> {
  const projectItems = workItems.filter(
    (item) => item.source.type === "project" && item.source.sourceId === projectId
  );

  // If no items, not terminal (no items to complete)
  if (projectItems.length === 0) {
    return { isTerminal: false, status: null, summary: '' };
  }

  // If any item is not in a terminal state, project is not done
  const nonTerminal = projectItems.filter((item) => !isTerminalState(item.status));
  if (nonTerminal.length > 0) {
    return { isTerminal: false, status: null, summary: '' };
  }

  // All items are in terminal states
  const mergedItems = projectItems.filter((item) => item.status === 'merged');
  const failedItems = projectItems.filter((item) => item.status !== 'merged');

  if (failedItems.length === 0) {
    return {
      isTerminal: true,
      status: 'Complete',
      summary: `All ${mergedItems.length} items merged`,
    };
  }

  // Mix or all failed — a project is Failed if any item is in a non-merged terminal state
  const failedTitles = failedItems.map((item) => item.title || item.id).join(', ');
  const summary =
    mergedItems.length > 0
      ? `${mergedItems.length} merged, ${failedItems.length} failed/parked: ${failedTitles}`
      : `All items failed/parked: ${failedTitles}`;

  return {
    isTerminal: true,
    status: 'Failed',
    summary,
  };
}

export async function transitionProject(
  projectId: string,
  status: 'Complete' | 'Failed',
  summary: string
): Promise<void> {
  await updateProjectStatus(projectId, status);
  console.log(`[projects] Transitioned project ${projectId} to ${status}: ${summary}`);
}

export async function listProjects(status?: ProjectStatus): Promise<Project[]> {
  return queryProjects(status);
}

export async function getExecuteProjects(): Promise<Project[]> {
  return queryProjects("Execute");
}

export async function transitionToExecuting(
  project: Project,
): Promise<boolean> {
  return updateProjectStatus(project.id, "Executing");
}

export async function transitionToComplete(
  project: Project,
): Promise<boolean> {
  return updateProjectStatus(project.id, "Complete");
}

export async function transitionToFailed(
  project: Project,
): Promise<boolean> {
  return updateProjectStatus(project.id, "Failed");
}

function formatDuration(earliestCreated: string, latestUpdated: string): string {
  const start = new Date(earliestCreated).getTime();
  const end = new Date(latestUpdated).getTime();
  if (isNaN(start) || isNaN(end) || end <= start) return "unknown";

  const diffMs = end - start;
  const totalMinutes = Math.floor(diffMs / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);
  const remainingHours = totalHours % 24;
  const remainingMinutes = totalMinutes % 60;

  if (totalDays > 0) return `${totalDays}d ${remainingHours}h`;
  if (totalHours > 0) return `${totalHours}h ${remainingMinutes}m`;
  return `${totalMinutes}m`;
}

function getFailureReason(item: WorkItem): string {
  return item.escalation?.reason || "No failure context recorded";
}

function assessRecovery(failedItems: WorkItem[]): { retryable: string; reason: string; recommendation: string } {
  if (failedItems.length === 0) {
    return { retryable: "N/A", reason: "No failures recorded", recommendation: "Review remaining items manually" };
  }

  const reasons = failedItems.map(getFailureReason).map((r) => r.toLowerCase());
  const transientKeywords = ["ci", "timeout", "network", "rate limit"];
  const conflictKeywords = ["conflict", "plan", "merge conflict", "design", "dependency"];

  const allTransient = reasons.every((r) => transientKeywords.some((k) => r.includes(k)));
  const anyConflict = reasons.some((r) => conflictKeywords.some((k) => r.includes(k)));

  if (allTransient) {
    return { retryable: "Yes", reason: "All failures appear to be transient CI/infrastructure issues", recommendation: "Retry" };
  }
  if (anyConflict) {
    return { retryable: "Partial", reason: "Some failures involve conflicts or plan-level issues", recommendation: "Re-plan" };
  }
  return { retryable: "No", reason: "Failures do not match known transient patterns", recommendation: "Abandon" };
}

function formatItemLine(item: WorkItem): string {
  const repo = item.targetRepo;
  const pr = item.execution?.prNumber ? `#${item.execution.prNumber}` : "(no PR)";
  return `- ${repo}${pr}: ${item.title}`;
}

export async function writeOutcomeSummary(
  projectId: string,
  status: "Complete" | "Failed",
): Promise<void> {
  // Find the project to get its Notion page ID
  const projects = await listProjects();
  const project = projects.find((p) => p.id === projectId || p.projectId === projectId);
  if (!project) {
    console.warn(`[projects] writeOutcomeSummary: project ${projectId} not found, skipping`);
    return;
  }

  const notionPageId = project.id;

  // Fetch all work items and load full details for project items
  const indexEntries = await listWorkItems();
  const allItems: WorkItem[] = [];
  for (const entry of indexEntries) {
    const item = await getWorkItem(entry.id);
    if (item && item.source.type === "project" && item.source.sourceId === projectId) {
      allItems.push(item);
    }
  }

  // Handle zero work items
  if (allItems.length === 0) {
    const minimal = `## Outcome Summary\n\n**Status:** ${status}\n\n_No work items found for this project._`;
    await appendPageContent(notionPageId, minimal);
    return;
  }

  // Compute stats
  const merged = allItems.filter((i) => i.status === "merged");
  const failed = allItems.filter((i) => i.status === "failed");
  const remainingStatuses = ["ready", "blocked", "queued", "parked"] as const;
  const remaining = allItems.filter((i) => (remainingStatuses as readonly string[]).includes(i.status));
  const total = allItems.length;

  const estimatedCost = allItems.reduce((sum, i) => {
    const budget = i.handoff?.budget;
    if (budget == null) return sum;
    const val = typeof budget === "string" ? parseFloat(budget) : budget;
    return isNaN(val) ? sum : sum + val;
  }, 0);

  // Compute duration
  const timestamps = allItems.map((i) => ({ created: i.createdAt, updated: i.updatedAt }));
  const createdTimes = timestamps.map((t) => new Date(t.created).getTime()).filter((t) => !isNaN(t));
  const updatedTimes = timestamps.map((t) => new Date(t.updated).getTime()).filter((t) => !isNaN(t));
  const duration =
    createdTimes.length > 0 && updatedTimes.length > 0
      ? formatDuration(new Date(Math.min(...createdTimes)).toISOString(), new Date(Math.max(...updatedTimes)).toISOString())
      : "unknown";

  // Build markdown
  const lines: string[] = [];
  lines.push(`## Outcome Summary`);
  lines.push(``);
  lines.push(`**Status:** ${status}`);
  lines.push(`**Duration:** ${duration}`);
  lines.push(`**Items:** ${merged.length} merged, ${failed.length} failed, ${remaining.length} remaining (${total} total)`);
  lines.push(`**Estimated Cost:** $${estimatedCost.toFixed(2)}`);

  if (status === "Complete") {
    lines.push(``);
    lines.push(`### Merged PRs`);
    lines.push(``);
    if (merged.length > 0) {
      for (const item of merged) lines.push(formatItemLine(item));
    } else {
      lines.push(`_None_`);
    }

    const cancelled = allItems.filter((i) => i.status === "cancelled");
    if (cancelled.length > 0) {
      lines.push(``);
      lines.push(`### Notes`);
      lines.push(``);
      for (const item of cancelled) lines.push(`- ${item.title} (cancelled)`);
    }
  } else {
    // Failed status
    lines.push(``);
    lines.push(`### What Shipped`);
    lines.push(``);
    if (merged.length > 0) {
      for (const item of merged) lines.push(formatItemLine(item));
    } else {
      lines.push(`_None_`);
    }

    lines.push(``);
    lines.push(`### What Failed`);
    lines.push(``);
    if (failed.length > 0) {
      for (const item of failed) lines.push(`${formatItemLine(item)} — ${getFailureReason(item)}`);
    } else {
      lines.push(`_None_`);
    }

    lines.push(``);
    lines.push(`### What Remains`);
    lines.push(``);
    if (remaining.length > 0) {
      for (const item of remaining) lines.push(`- ${item.title} (${item.status})`);
    } else {
      lines.push(`_None_`);
    }

    const recovery = assessRecovery(failed);
    lines.push(``);
    lines.push(`### Recovery Assessment`);
    lines.push(``);
    lines.push(`**Retryable:** ${recovery.retryable}`);
    lines.push(`**Reason:** ${recovery.reason}`);
    lines.push(`**Recommendation:** ${recovery.recommendation}`);
  }

  await appendPageContent(notionPageId, lines.join("\n"));
}
