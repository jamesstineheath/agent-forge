import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { fetchPageContent } from "./notion";
import { fetchRepoContext, type RepoContext } from "./orchestrator";
import { listRepos, getRepo } from "./repos";
import { createWorkItem, updateWorkItem } from "./work-items";
import { escalate } from "./escalation";
import { buildCachedPrompt } from "./prompt-cache";
import type { Project, WorkItem, RepoConfig } from "./types";

// --- Types ---

interface DecomposedItem {
  title: string;
  description: string;
  targetRepo: string;
  priority: "high" | "medium" | "low";
  riskLevel: "low" | "medium" | "high";
  complexity: "simple" | "moderate" | "complex";
  dependencies: number[];
  acceptanceCriteria: string[];
}

// --- Helpers ---

/**
 * Extract the 32-hex-char page ID from a Notion URL or raw UUID.
 * Handles: https://www.notion.so/Page-Title-<32hex> and raw UUIDs with/without hyphens.
 */
export function extractPageId(planUrl: string): string {
  // Strip hyphens from any UUID-like input
  const cleaned = planUrl.replace(/-/g, "");

  // If it's already a 32 hex string, return it
  if (/^[a-f0-9]{32}$/i.test(cleaned)) return cleaned;

  // Extract from URL: last 32 hex chars of the path
  try {
    const url = new URL(planUrl);
    const path = url.pathname.replace(/-/g, "");
    const match = path.match(/([a-f0-9]{32})$/i);
    if (match) return match[1];
  } catch {
    // Not a URL, try extracting hex from the string
    const match = cleaned.match(/([a-f0-9]{32})/i);
    if (match) return match[1];
  }

  throw new Error(`Cannot extract Notion page ID from: ${planUrl}`);
}

/**
 * Parse repos mentioned in plan content by matching against registered repos.
 */
async function findReferencedRepos(
  planContent: string,
  primaryRepo: string,
): Promise<RepoConfig[]> {
  const repoIndex = await listRepos();
  const repoConfigs: RepoConfig[] = [];
  const seen = new Set<string>();

  for (const entry of repoIndex) {
    // Check if the plan mentions this repo by full name or short name
    if (
      planContent.includes(entry.fullName) ||
      planContent.includes(entry.shortName) ||
      entry.fullName === primaryRepo
    ) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        const config = await getRepo(entry.id);
        if (config) repoConfigs.push(config);
      }
    }
  }

  return repoConfigs;
}

/**
 * Validate the decomposed items array from Claude's output.
 * Returns an error message if invalid, null if valid.
 */
function validateDecomposition(items: DecomposedItem[]): string | null {
  if (!Array.isArray(items)) return "Output is not an array";
  if (items.length === 0) return "Output array is empty";

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.title) return `Item ${i}: missing title`;
    if (!item.description) return `Item ${i}: missing description`;
    if (!item.targetRepo) return `Item ${i}: missing targetRepo`;
    if (!item.priority) return `Item ${i}: missing priority`;
    if (!item.riskLevel) return `Item ${i}: missing riskLevel`;
    if (!item.complexity) return `Item ${i}: missing complexity`;
    if (!Array.isArray(item.dependencies)) return `Item ${i}: dependencies is not an array`;
    if (!Array.isArray(item.acceptanceCriteria)) return `Item ${i}: acceptanceCriteria is not an array`;
    if (item.acceptanceCriteria.length < 3 || item.acceptanceCriteria.length > 5) {
      return `Item ${i}: acceptanceCriteria must have 3-5 items (got ${item.acceptanceCriteria.length})`;
    }

    // Validate dependency indices
    for (const dep of item.dependencies) {
      if (typeof dep !== "number") return `Item ${i}: dependency ${dep} is not a number`;
      if (dep === i) return `Item ${i}: self-reference in dependencies`;
      if (dep < 0 || dep >= items.length) return `Item ${i}: dependency index ${dep} out of bounds`;
    }
  }

  // Check for circular dependencies
  const circularError = detectCircularDependencies(items);
  if (circularError) return circularError;

  return null;
}

/**
 * Detect circular dependencies in the decomposed items graph.
 */
function detectCircularDependencies(items: DecomposedItem[]): string | null {
  const visited = new Set<number>();
  const inStack = new Set<number>();

  function dfs(index: number): boolean {
    if (inStack.has(index)) return true; // cycle found
    if (visited.has(index)) return false;

    visited.add(index);
    inStack.add(index);

    for (const dep of items[index].dependencies) {
      if (dfs(dep)) return true;
    }

    inStack.delete(index);
    return false;
  }

  for (let i = 0; i < items.length; i++) {
    if (dfs(i)) return `Circular dependency detected involving item ${i}`;
  }

  return null;
}

// --- Decomposition Prompt ---

const SYSTEM_PROMPT = `You are a Plan Decomposer for an autonomous dev pipeline. Your job is to read an architecture
specification and break it into a DAG of small, independently executable work items that maximizes parallel execution.

Each work item will be expanded into a handoff file and executed by an AI coding agent (Claude Code)
in a GitHub Actions environment. The agent has no context beyond the handoff file and the target
repo's CLAUDE.md / system map.

CONSTRAINTS:
- Each work item should touch 1-3 files maximum
- Each work item must compile and pass tests independently after execution
- Each work item must have 3-5 specific, testable acceptance criteria
- Dependencies must form a DAG (no cycles). MAXIMIZE PARALLELISM: only add a dependency if item B truly cannot start until item A is merged. If two items touch different files or subsystems, they should have NO dependency between them even if one is "logically first". The pipeline can execute independent items concurrently.
- Prefer wide, shallow DAGs over deep linear chains. A 10-item plan with 3 parallel tracks of 3-4 items each is far better than a single 10-item sequence.
- Prefer more, smaller items over fewer, larger ones
- The first item in the sequence should be the lowest-risk foundational change
- Include a final integration/E2E test item that depends on all others

OUTPUT FORMAT:
Return a JSON array (no markdown fencing, no explanation) where each element is:
{
  "title": "Short descriptive title",
  "description": "Rich description including: what to implement, files to create/modify, key implementation details (function signatures, data structures), and acceptance criteria",
  "targetRepo": "owner/repo-name",
  "priority": "high|medium|low",
  "riskLevel": "low|medium|high",
  "complexity": "simple|moderate|complex",
  "dependencies": [0, 1],
  "acceptanceCriteria": [
    "Specific testable criterion 1",
    "Specific testable criterion 2"
  ]
}`;

/**
 * Build the repo context block (semi-static — same for all plans targeting the same repos).
 * Separated from plan content so it can be cached via Anthropic prompt caching.
 */
function buildRepoContextBlock(
  repoContexts: Map<string, RepoContext>,
): string {
  if (repoContexts.size === 0) return "";

  let block = "";
  for (const [repoName, ctx] of repoContexts) {
    block += `## Repo Context: ${repoName}\n\n`;
    block += `### CLAUDE.md\n${ctx.claudeMd || "(not available)"}\n\n`;
    block += `### System Map\n${ctx.systemMap || "(not configured)"}\n\n`;
    block += `### ADRs\n`;
    if (ctx.adrs.length > 0) {
      block += ctx.adrs
        .map((adr) => `- **${adr.title}** (${adr.status}): ${adr.decision}`)
        .join("\n");
    } else {
      block += "(none)";
    }
    block += `\n\n### Recent PRs\n`;
    if (ctx.recentPRs.length > 0) {
      block += ctx.recentPRs
        .map((pr) => `- ${pr.title}\n  Files: ${pr.files.slice(0, 5).join(", ")}`)
        .join("\n");
    } else {
      block += "(none)";
    }
    block += "\n\n";
  }
  return block.trim();
}

/**
 * Build the dynamic plan prompt (changes on every call — not cached).
 */
function buildPlanPrompt(
  planContent: string,
  project: Project,
): string {
  let prompt = `## Architecture Plan\n\n${planContent}\n\n`;

  prompt += `## Project Metadata\n`;
  prompt += `- **Title:** ${project.title}\n`;
  prompt += `- **Priority:** ${project.priority ?? "P1"}\n`;
  prompt += `- **Complexity:** ${project.complexity ?? "Moderate"}\n`;
  prompt += `- **Risk Level:** ${project.riskLevel ?? "Medium"}\n`;
  prompt += `- **Primary Target Repo:** ${project.targetRepo ?? "unknown"}\n\n`;

  prompt += `Decompose this plan into ordered work items now.`;
  return prompt;
}

// --- Main ---

export async function decomposeProject(project: Project): Promise<WorkItem[]> {
  // 1. Extract page ID and fetch plan content
  if (!project.planUrl) {
    await escalate(
      `project:${project.projectId}`,
      "Project has no plan URL",
      0.9,
      { projectId: project.projectId, title: project.title },
      project.projectId,
    );
    return [];
  }

  const pageId = extractPageId(project.planUrl);
  const planContent = await fetchPageContent(pageId);

  if (!planContent || planContent.trim().length < 50) {
    await escalate(
      `project:${project.projectId}`,
      "Plan page is empty or lacks an identifiable problem statement",
      0.8,
      { projectId: project.projectId, pageId, contentLength: planContent.length },
      project.projectId,
    );
    return [];
  }

  // 2. Determine target repos
  const primaryRepo = project.targetRepo
    ? `jamesstineheath/${project.targetRepo}`
    : null;

  if (!primaryRepo) {
    await escalate(
      `project:${project.projectId}`,
      "Project has no target repo configured",
      0.9,
      { projectId: project.projectId },
      project.projectId,
    );
    return [];
  }

  const referencedRepos = await findReferencedRepos(planContent, primaryRepo);

  if (referencedRepos.length === 0) {
    await escalate(
      `project:${project.projectId}`,
      `Plan references repos not registered in Agent Forge. Primary repo "${primaryRepo}" not found.`,
      0.7,
      { projectId: project.projectId, primaryRepo },
      project.projectId,
    );
    return [];
  }

  // 3. Fetch repo context for each target repo
  const repoContexts = new Map<string, RepoContext>();
  for (const repo of referencedRepos) {
    const ctx = await fetchRepoContext(repo);
    repoContexts.set(repo.fullName, ctx);
  }

  // 4. Call Claude Opus for decomposition
  const repoContextBlock = buildRepoContextBlock(repoContexts);
  const planPrompt = buildPlanPrompt(planContent, project);

  // Use buildCachedPrompt for organizational structure
  const cachedPrompt = buildCachedPrompt(
    {
      enabled: true,
      staticSections: repoContextBlock
        ? [SYSTEM_PROMPT, repoContextBlock]
        : [SYSTEM_PROMPT],
    },
    planPrompt,
  );

  // Build system blocks with Anthropic prompt caching via AI SDK providerOptions.
  // cache_control goes on the last static/semi-static block:
  //   - If repo context is present: cache_control on repo context block
  //   - If repo context is absent: cache_control on the static guidelines block
  const systemBlocks: Array<{
    role: "system";
    content: string;
    providerOptions?: {
      anthropic: { cacheControl: { type: "ephemeral" } };
    };
  }> = [];

  if (repoContextBlock) {
    systemBlocks.push({
      role: "system" as const,
      content: SYSTEM_PROMPT,
    });
    systemBlocks.push({
      role: "system" as const,
      content: repoContextBlock,
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    });
  } else {
    systemBlocks.push({
      role: "system" as const,
      content: SYSTEM_PROMPT,
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    });
  }

  let decomposedItems: DecomposedItem[] | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const promptToSend =
      attempt === 0
        ? cachedPrompt.dynamicSuffix
        : `${cachedPrompt.dynamicSuffix}\n\n---\nPREVIOUS ATTEMPT FAILED VALIDATION:\n${lastError}\n\nPlease fix the issues and return a valid JSON array.`;

    const { text } = await generateText({
      model: anthropic("claude-opus-4-6"),
      system: systemBlocks,
      prompt: promptToSend,
    });

    // Strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();

    try {
      const parsed = JSON.parse(cleaned);
      const validationError = validateDecomposition(parsed);
      if (validationError) {
        lastError = validationError;
        console.warn(`[decomposer] Attempt ${attempt + 1} validation failed: ${validationError}`);
        continue;
      }
      decomposedItems = parsed;
      break;
    } catch (err) {
      lastError = `JSON parse error: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[decomposer] Attempt ${attempt + 1} parse failed: ${lastError}`);
    }
  }

  if (!decomposedItems) {
    await escalate(
      `project:${project.projectId}`,
      `Decomposition failed after 2 attempts: ${lastError}`,
      0.6,
      { projectId: project.projectId, lastError },
      project.projectId,
    );
    return [];
  }

  // 5. Check item count limit
  if (decomposedItems.length > 15) {
    await escalate(
      `project:${project.projectId}`,
      `Decomposition produced ${decomposedItems.length} items (max 15). The plan should be split into smaller phases.`,
      0.7,
      { projectId: project.projectId, itemCount: decomposedItems.length },
      project.projectId,
    );
    return [];
  }

  // 6. Create work items, mapping indices to actual IDs
  const indexToId = new Map<number, string>();
  const createdItems: WorkItem[] = [];

  for (let i = 0; i < decomposedItems.length; i++) {
    const item = decomposedItems[i];

    // Embed acceptance criteria in description
    const descriptionWithCriteria = `${item.description}\n\n## Acceptance Criteria\n${item.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`;

    // Resolve dependency indices to work item IDs
    const resolvedDeps = item.dependencies
      .map((depIdx) => indexToId.get(depIdx))
      .filter((id): id is string => id !== undefined);

    const workItem = await createWorkItem({
      title: item.title,
      description: descriptionWithCriteria,
      targetRepo: item.targetRepo,
      source: {
        type: "project",
        sourceId: project.projectId,
      },
      priority: item.priority,
      riskLevel: item.riskLevel,
      complexity: item.complexity,
      dependencies: resolvedDeps,
    });

    indexToId.set(i, workItem.id);
    createdItems.push(workItem);
  }

  // 7. Set all created items to "ready"
  for (const item of createdItems) {
    await updateWorkItem(item.id, { status: "ready" });
  }

  console.log(
    `[decomposer] Created ${createdItems.length} work items for project ${project.projectId}`,
  );

  return createdItems;
}
