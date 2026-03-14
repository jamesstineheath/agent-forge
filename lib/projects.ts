import { queryProjects, updateProjectStatus } from "./notion";
import type { Project, ProjectStatus } from "./types";

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
