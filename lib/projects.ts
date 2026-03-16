import { queryProjects, updateProjectStatus } from "./notion";
import type { Project, ProjectStatus, WorkItem } from "./types";

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
