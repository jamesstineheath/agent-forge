/**
 * MCP utility functions.
 */

export const GITHUB_OWNER = "jamesstineheath";
const DEFAULT_REPO = "agent-forge";
const PA_REPO = "personal-assistant";

/**
 * Resolve a short repo name to full "owner/repo" format.
 * Accepts: undefined (defaults to agent-forge), short names, or full names.
 */
export function resolveRepo(repo?: string): string {
  if (!repo) return `${GITHUB_OWNER}/${DEFAULT_REPO}`;
  if (repo.includes("/")) return repo;
  // Expand known short names
  if (repo === "personal-assistant" || repo === "pa") return `${GITHUB_OWNER}/${PA_REPO}`;
  return `${GITHUB_OWNER}/${repo}`;
}
