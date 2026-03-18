import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { fetchPageContent } from "./notion";
import { fetchRepoContext, type RepoContext } from "./orchestrator";
import { listRepos, getRepo } from "./repos";
import { createWorkItem, updateWorkItem } from "./work-items";
import { escalate } from "./escalation";
import type { Project, WorkItem, RepoConfig, DecomposerConfig, SubPhase, PhaseBreakdown } from "./types";

// --- Constants ---

const DECOMPOSER_SOFT_LIMIT = parseInt(process.env.DECOMPOSER_SOFT_LIMIT || "15");
const DECOMPOSER_HARD_LIMIT = parseInt(process.env.DECOMPOSER_HARD_LIMIT || "30");

// --- Sub-phase decomposition helpers ---

/** Generate alphabetic suffix for phase index (0→'a', 1→'b', ..., 25→'z'). */
export function phaseLabel(index: number): string {
  if (index < 26) return String.fromCharCode(97 + index);
  // Beyond 26: 'aa', 'ab', etc.
  const first = Math.floor(index / 26) - 1;
  const second = index % 26;
  return String.fromCharCode(97 + first) + String.fromCharCode(97 + second);
}

/**
 * Stitch cross-phase dependencies: validate all dependency IDs exist in the
 * flattened item set. Returns the flattened WorkItem array.
 */
export function stitchCrossPhaseDeps(allItems: WorkItem[]): WorkItem[] {
  const allItemIds = new Set(allItems.map((item) => item.id));
  // Filter out any dangling dependency references
  return allItems.map((item) => ({
    ...item,
    dependencies: item.dependencies.filter((dep) => allItemIds.has(dep)),
  }));
}

/**
 * Recursively decompose items into sub-phases when count is in the
 * softLimit < N <= hardLimit range. Each sub-phase is validated against
 * the soft limit; oversized sub-phases are recursively re-decomposed
 * up to maxRecursionDepth.
 */
async function decomposeSubPhases(
  items: WorkItem[],
  targetPhaseCount: number,
  projectId: string,
  softLimit: number,
  maxRecursionDepth: number,
  depth: number,
): Promise<{ items: WorkItem[]; phases: SubPhase[] }> {
  const phases = groupIntoSubPhases(items, targetPhaseCount);
  const totalItemCount = items.length;
  const resultItems: WorkItem[] = [];
  const resultPhases: SubPhase[] = [];

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const phaseId = `${projectId}-${phaseLabel(i)}`;

    // Tag items with phase context
    const phasedItems = phase.items.map((item) => ({
      ...item,
    }));

    if (phasedItems.length <= softLimit) {
      resultItems.push(...phasedItems);
      resultPhases.push({
        ...phase,
        id: phaseId,
        parentProjectId: projectId,
        name: phaseId,
      });
    } else if (depth >= maxRecursionDepth) {
      // Escalate: sub-phase still too large after max recursion
      throw new SubPhaseEscalationError(
        `Sub-phase '${phase.name}' still has ${phasedItems.length} items after recursive decomposition. Manual intervention needed.`,
        phase.name,
        phasedItems.length,
      );
    } else {
      // Recurse once
      const recursed = await decomposeSubPhases(
        phasedItems,
        Math.ceil(phasedItems.length / softLimit),
        phaseId,
        softLimit,
        maxRecursionDepth,
        depth + 1,
      );
      resultItems.push(...recursed.items);
      resultPhases.push(...recursed.phases);
    }
  }

  // Stitch cross-phase dependencies (validate all dep IDs exist)
  const stitched = stitchCrossPhaseDeps(resultItems);
  return { items: stitched, phases: resultPhases };
}

/** Error thrown when a sub-phase exceeds soft limit after max recursion depth. */
export class SubPhaseEscalationError extends Error {
  constructor(
    message: string,
    public phaseName: string,
    public phaseSize: number,
  ) {
    super(message);
    this.name = "SubPhaseEscalationError";
  }
}

// --- Types ---

export interface DecompositionResult {
  workItems: WorkItem[];
  phases: WorkItem[][] | null;
  phaseBreakdown?: PhaseBreakdown;
}

interface DecomposedItem {
  title: string;
  description: string;
  targetRepo: string;
  priority: "high" | "medium" | "low";
  riskLevel: "low" | "medium" | "high";
  complexity: "simple" | "moderate" | "complex";
  dependencies: number[];
  acceptanceCriteria: string[];
  estimatedFiles: string[];
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
    if (!Array.isArray(item.estimatedFiles)) return `Item ${i}: estimatedFiles is not an array`;
    if (item.estimatedFiles.length === 0) return `Item ${i}: estimatedFiles must list at least one file`;

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

// Files that are commonly touched by many items (e.g., shared type files, config).
// Overlaps on these files won't auto-inject dependency edges to avoid over-serialization.
const SHARED_FILES_ALLOWLIST = new Set([
  "lib/types.ts",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
]);

/**
 * Post-processing pass: inject dependency edges between items that share estimated files.
 * For each file touched by multiple items, creates a chain (lowest index -> next -> next)
 * so they execute sequentially. Skips files in the shared allowlist.
 * Only adds edges that don't already exist and don't create cycles.
 */
function injectFileOverlapDependencies(items: DecomposedItem[]): number {
  // Build map: file -> sorted list of item indices that touch it
  const fileToItems = new Map<string, number[]>();
  for (let i = 0; i < items.length; i++) {
    for (const file of items[i].estimatedFiles) {
      if (SHARED_FILES_ALLOWLIST.has(file)) continue;
      if (!fileToItems.has(file)) fileToItems.set(file, []);
      fileToItems.get(file)!.push(i);
    }
  }

  let injectedCount = 0;

  for (const [, indices] of fileToItems) {
    if (indices.length < 2) continue;

    // Chain items: each item depends on the previous one touching this file
    for (let j = 1; j < indices.length; j++) {
      const depIdx = indices[j - 1];
      const itemIdx = indices[j];

      // Skip if dependency already exists
      if (items[itemIdx].dependencies.includes(depIdx)) continue;

      // Skip if adding this edge would create a cycle
      // (check if depIdx is reachable from itemIdx via existing deps)
      if (isReachable(items, itemIdx, depIdx)) continue;

      items[itemIdx].dependencies.push(depIdx);
      injectedCount++;
    }
  }

  return injectedCount;
}

/**
 * Check if `target` is reachable from `start` via the dependency graph.
 * Used to prevent cycle creation when injecting new edges.
 */
function isReachable(items: DecomposedItem[], start: number, target: number): boolean {
  const visited = new Set<number>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const dep of items[current].dependencies) {
      queue.push(dep);
    }
  }
  return false;
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
  ],
  "estimatedFiles": ["lib/foo.ts", "lib/bar.ts"]
}

IMPORTANT: estimatedFiles must list ALL files this work item will create or modify. The pipeline uses this to detect file-level conflicts and automatically add dependency edges between items that touch the same files. Accurate file estimates prevent merge conflicts.`;

/**
 * Build the repo context string (semi-static: changes per repo, not per call).
 */
function buildRepoContext(
  project: Project,
  repoContexts: Map<string, RepoContext>,
): string {
  let context = `## Project Metadata\n`;
  context += `- **Title:** ${project.title}\n`;
  context += `- **Priority:** ${project.priority ?? "P1"}\n`;
  context += `- **Complexity:** ${project.complexity ?? "Moderate"}\n`;
  context += `- **Risk Level:** ${project.riskLevel ?? "Medium"}\n`;
  context += `- **Primary Target Repo:** ${project.targetRepo ?? "unknown"}\n\n`;

  for (const [repoName, ctx] of repoContexts) {
    context += `## Repo Context: ${repoName}\n\n`;
    context += `### CLAUDE.md\n${ctx.claudeMd || "(not available)"}\n\n`;
    context += `### System Map\n${ctx.systemMap || "(not configured)"}\n\n`;
    context += `### ADRs\n`;
    if (ctx.adrs.length > 0) {
      context += ctx.adrs
        .map((adr) => `- **${adr.title}** (${adr.status}): ${adr.decision}`)
        .join("\n");
    } else {
      context += "(none)";
    }
    context += `\n\n### Recent PRs\n`;
    if (ctx.recentPRs.length > 0) {
      context += ctx.recentPRs
        .map((pr) => `- ${pr.title}\n  Files: ${pr.files.slice(0, 5).join(", ")}`)
        .join("\n");
    } else {
      context += "(none)";
    }
    context += "\n\n";
  }

  return context;
}

/**
 * Build the dynamic plan content string (changes every call).
 */
function buildPlanPrompt(planContent: string): string {
  return `## Architecture Plan\n\n${planContent}\n\nDecompose this plan into ordered work items now.`;
}

// --- Sub-Phase Splitting ---

/**
 * Split decomposed items into 2-3 sub-phases based on dependency clustering.
 * Items that depend on each other go in the same phase. Items with no
 * cross-dependencies form separate phases. Phases are ordered so that
 * dependencies flow forward (phase A before phase B).
 */
function splitIntoSubPhases(items: DecomposedItem[]): DecomposedItem[][] {
  const n = items.length;

  // Build adjacency (undirected) for clustering: items connected by
  // dependencies should be in the same phase when possible
  const adj = new Map<number, Set<number>>();
  for (let i = 0; i < n; i++) adj.set(i, new Set());
  for (let i = 0; i < n; i++) {
    for (const dep of items[i].dependencies) {
      adj.get(i)!.add(dep);
      adj.get(dep)!.add(i);
    }
  }

  // Connected-components via BFS
  const componentOf = new Array<number>(n).fill(-1);
  let componentCount = 0;
  for (let i = 0; i < n; i++) {
    if (componentOf[i] !== -1) continue;
    const queue = [i];
    componentOf[i] = componentCount;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const neighbor of adj.get(cur)!) {
        if (componentOf[neighbor] === -1) {
          componentOf[neighbor] = componentCount;
          queue.push(neighbor);
        }
      }
    }
    componentCount++;
  }

  // Group items by component
  const components = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const c = componentOf[i];
    if (!components.has(c)) components.set(c, []);
    components.get(c)!.push(i);
  }

  // Sort components by topological order: earliest item index in each component
  const sortedComponents = [...components.values()].sort(
    (a, b) => Math.min(...a) - Math.min(...b),
  );

  // Merge components into 2-3 phases, distributing evenly
  const targetPhaseCount = sortedComponents.length >= 3 ? 3 : 2;
  const phases: number[][] = Array.from({ length: targetPhaseCount }, () => []);

  // Greedy bin-packing: assign each component to the phase with fewest items
  for (const component of sortedComponents) {
    let minPhase = 0;
    for (let p = 1; p < phases.length; p++) {
      if (phases[p].length < phases[minPhase].length) minPhase = p;
    }
    phases[minPhase].push(...component);
  }

  // Remove empty phases
  const nonEmptyPhases = phases.filter((p) => p.length > 0);

  // Sort items within each phase by original index to preserve ordering
  for (const phase of nonEmptyPhases) {
    phase.sort((a, b) => a - b);
  }

  // Order phases so dependencies flow forward: a phase whose items are
  // depended upon by items in another phase should come first
  nonEmptyPhases.sort((phaseA, phaseB) => {
    const setA = new Set(phaseA);
    const setB = new Set(phaseB);
    // If any item in B depends on an item in A, A should come first
    for (const idx of phaseB) {
      for (const dep of items[idx].dependencies) {
        if (setA.has(dep)) return -1;
      }
    }
    // If any item in A depends on an item in B, B should come first
    for (const idx of phaseA) {
      for (const dep of items[idx].dependencies) {
        if (setB.has(dep)) return 1;
      }
    }
    return Math.min(...phaseA) - Math.min(...phaseB);
  });

  // Map back to DecomposedItem arrays
  return nonEmptyPhases.map((phase) => phase.map((idx) => items[idx]));
}

// --- Main ---

export async function decomposeProject(project: Project): Promise<DecompositionResult> {
  // 1. Extract page ID and fetch plan content
  // If planUrl is set, extract its page ID; otherwise fall back to reading the project page body
  const pageId = project.planUrl
    ? extractPageId(project.planUrl)
    : project.id;
  const planContent = await fetchPageContent(pageId);

  console.log(
    `[Decomposer] Fetched plan content for project "${project.title}" (${project.projectId}). ` +
    `Content length: ${planContent?.length ?? 0} chars, pageId: ${pageId}`
  );

  if (!planContent || planContent.trim().length < 50) {
    console.error(
      `[Decomposer] Plan content too short or empty for project "${project.title}" (${project.projectId}).`,
      JSON.stringify({
        projectId: project.projectId,
        pageId,
        contentLength: planContent?.length ?? 0,
        contentPreview: planContent?.slice(0, 200) ?? "(null)",
      }, null, 2)
    );
    await escalate(
      `project:${project.projectId}`,
      "Plan page is empty or lacks an identifiable problem statement",
      0.8,
      { projectId: project.projectId, pageId, contentLength: planContent.length },
      project.projectId,
    );
    return { workItems: [], phases: null };
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
    return { workItems: [], phases: null };
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
    return { workItems: [], phases: null };
  }

  // 3. Fetch repo context for each target repo
  const repoContexts = new Map<string, RepoContext>();
  for (const repo of referencedRepos) {
    const ctx = await fetchRepoContext(repo);
    repoContexts.set(repo.fullName, ctx);
  }

  // 4. Call Claude Opus for decomposition
  const repoContext = buildRepoContext(project, repoContexts);
  const planPrompt = buildPlanPrompt(planContent);

  // Anthropic prompt caching provider options
  const cacheEphemeral = {
    anthropic: { cacheControl: { type: "ephemeral" as const } },
  };

  let decomposedItems: DecomposedItem[] | null = null;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const dynamicContent =
      attempt === 0
        ? planPrompt
        : `${planPrompt}\n\n---\nPREVIOUS ATTEMPT FAILED VALIDATION:\n${lastError}\n\nPlease fix the issues and return a valid JSON array.`;

    const { text } = await generateText({
      model: anthropic("claude-opus-4-6"),
      system: {
        role: "system" as const,
        content: SYSTEM_PROMPT,
        providerOptions: cacheEphemeral,
      },
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: repoContext,
              providerOptions: cacheEphemeral,
            },
            {
              type: "text" as const,
              text: dynamicContent,
            },
          ],
        },
      ],
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
    console.error(
      `[Decomposer] Decomposition produced 0 valid items after 2 attempts for project "${project.title}" (${project.projectId}).`,
      JSON.stringify({
        projectId: project.projectId,
        projectName: project.title,
        lastError,
        planContentLength: planContent.length,
        primaryRepo,
        referencedRepoCount: referencedRepos.length,
      }, null, 2)
    );
    await escalate(
      `project:${project.projectId}`,
      `Decomposition failed after 2 attempts: ${lastError}`,
      0.6,
      { projectId: project.projectId, lastError },
      project.projectId,
    );
    return { workItems: [], phases: null };
  }

  // 4.5. Inject file-overlap dependency edges (post-processing pass)
  const injectedDeps = injectFileOverlapDependencies(decomposedItems);
  if (injectedDeps > 0) {
    console.log(`[decomposer] Injected ${injectedDeps} file-overlap dependency edge(s)`);
    // Re-validate after injection (should not create cycles, but safety check)
    const postInjectError = detectCircularDependencies(decomposedItems);
    if (postInjectError) {
      console.error(`[decomposer] File-overlap injection created a cycle: ${postInjectError}. Reverting to original.`);
      // This shouldn't happen due to isReachable checks, but if it does, escalate
      await escalate(
        `project:${project.projectId}`,
        `File-overlap dependency injection created a circular dependency: ${postInjectError}`,
        0.6,
        { projectId: project.projectId, injectedDeps },
        project.projectId,
      );
      return { workItems: [], phases: null };
    }
  }

  // 5. Check item count limits and route accordingly
  const config = getDecomposerConfig();
  const { softLimit, hardLimit, maxRecursionDepth } = config;

  if (decomposedItems.length > hardLimit) {
    await escalate(
      `project:${project.projectId}`,
      `Decomposition produced ${decomposedItems.length} items (max ${hardLimit}). The plan should be split into smaller phases.`,
      0.7,
      { projectId: project.projectId, itemCount: decomposedItems.length },
      project.projectId,
    );
    return { workItems: [], phases: null };
  }

  // 6. If above soft limit, use recursive sub-phase decomposition
  let phases: DecomposedItem[][] | null = null;
  let subPhaseResult: { items: WorkItem[]; phases: SubPhase[] } | null = null;

  if (decomposedItems.length > softLimit) {
    // Convert DecomposedItems to temporary WorkItems for groupIntoSubPhases
    const tempWorkItems: WorkItem[] = decomposedItems.map((item, i) => ({
      id: `temp-${i}`,
      title: item.title,
      description: item.description,
      targetRepo: item.targetRepo,
      source: { type: "project" as const, sourceId: project.projectId },
      priority: item.priority,
      riskLevel: item.riskLevel,
      complexity: item.complexity,
      status: "filed" as const,
      dependencies: item.dependencies.map((dep) => `temp-${dep}`),
      handoff: null,
      execution: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    const targetPhaseCount = Math.ceil(decomposedItems.length / softLimit);
    const projectId = project.projectId || "phase";

    try {
      subPhaseResult = await decomposeSubPhases(
        tempWorkItems,
        targetPhaseCount,
        projectId,
        softLimit,
        maxRecursionDepth,
        0,
      );

      // Convert back: build DecomposedItem phases from SubPhase results
      phases = subPhaseResult.phases.map((sp) =>
        sp.items.map((wi) => {
          const origIdx = parseInt(wi.id.replace("temp-", ""), 10);
          return decomposedItems[isNaN(origIdx) ? 0 : origIdx];
        }).filter(Boolean),
      );

      console.log(
        `[decomposer] Split into ${subPhaseResult.phases.length} phases: ${subPhaseResult.phases.map((p) => p.items.length + " items").join(", ")}`,
      );
    } catch (err) {
      if (err instanceof SubPhaseEscalationError) {
        await escalate(
          `project:${project.projectId}`,
          err.message,
          0.7,
          {
            projectId: project.projectId,
            totalItems: decomposedItems.length,
            phaseName: err.phaseName,
            phaseSize: err.phaseSize,
          },
          project.projectId,
        );
        return { workItems: [], phases: null };
      }
      throw err;
    }
  }

  // 7. Create work items, mapping original indices to actual IDs
  const indexToId = new Map<number, string>();
  const createdItems: WorkItem[] = [];

  for (let i = 0; i < decomposedItems.length; i++) {
    const item = decomposedItems[i];

    // Embed acceptance criteria and estimated files in description
    const descriptionWithCriteria = `${item.description}\n\n## Acceptance Criteria\n${item.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n\n**Estimated files:** ${item.estimatedFiles.join(", ")}`;

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

  // 8. Set all created items to "ready"
  for (const item of createdItems) {
    await updateWorkItem(item.id, { status: "ready" });
  }

  console.log(
    `[decomposer] Created ${createdItems.length} work items for project ${project.projectId}`,
  );

  // Build WorkItem phases if sub-phase splitting occurred
  let workItemPhases: WorkItem[][] | null = null;
  if (phases) {
    // Map DecomposedItem phases to WorkItem phases using the original index mapping
    workItemPhases = phases.map((phase) =>
      phase
        .map((item) => {
          const origIdx = decomposedItems.indexOf(item);
          const id = indexToId.get(origIdx);
          return id ? createdItems.find((wi) => wi.id === id) : undefined;
        })
        .filter((wi): wi is WorkItem => wi !== undefined),
    );
  }

  // Build PhaseBreakdown for email rendering when sub-phases exist
  let phaseBreakdown: PhaseBreakdown | undefined;
  if (subPhaseResult && subPhaseResult.phases.length > 1) {
    phaseBreakdown = {
      phases: subPhaseResult.phases.map((sp) => ({
        id: sp.id,
        name: sp.name,
        itemCount: sp.items.length,
        items: sp.items.map((wi) => ({
          title: wi.title,
          priority: wi.priority,
        })),
      })),
      crossPhaseDeps: subPhaseResult.phases.flatMap((sp) =>
        sp.dependencies.map((depId) => ({ from: sp.id, to: depId })),
      ),
    };
  }

  return { workItems: createdItems, phases: workItemPhases, phaseBreakdown };
}

// --- Configurable decomposer limits ---

export function getDecomposerConfig(): DecomposerConfig {
  const softLimit = parseInt(process.env.DECOMPOSER_SOFT_LIMIT ?? '', 10);
  const hardLimit = parseInt(process.env.DECOMPOSER_HARD_LIMIT ?? '', 10);
  const maxRecursionDepth = parseInt(process.env.DECOMPOSER_MAX_RECURSION_DEPTH ?? '', 10);

  return {
    softLimit: isNaN(softLimit) ? 15 : softLimit,
    hardLimit: isNaN(hardLimit) ? 30 : hardLimit,
    maxRecursionDepth: isNaN(maxRecursionDepth) ? 1 : maxRecursionDepth,
  };
}

// ─── Union-Find helpers ───────────────────────────────────────────────────────

function makeUnionFind(ids: string[]): { parent: Map<string, string>; rank: Map<string, number> } {
  const parent = new Map(ids.map(id => [id, id]));
  const rank = new Map(ids.map(id => [id, 0]));
  return { parent, rank };
}

function ufFind(parent: Map<string, string>, x: string): string {
  if (parent.get(x) !== x) {
    parent.set(x, ufFind(parent, parent.get(x)!));
  }
  return parent.get(x)!;
}

function ufUnion(parent: Map<string, string>, rank: Map<string, number>, a: string, b: string): void {
  const ra = ufFind(parent, a);
  const rb = ufFind(parent, b);
  if (ra === rb) return;
  if ((rank.get(ra) ?? 0) < (rank.get(rb) ?? 0)) {
    parent.set(ra, rb);
  } else if ((rank.get(ra) ?? 0) > (rank.get(rb) ?? 0)) {
    parent.set(rb, ra);
  } else {
    parent.set(rb, ra);
    rank.set(ra, (rank.get(ra) ?? 0) + 1);
  }
}

// ─── Subsystem keyword extraction ────────────────────────────────────────────

function extractSubsystemKeywords(item: WorkItem): Set<string> {
  const text = `${item.title} ${item.description}`.toLowerCase();
  const keywords = new Set<string>();
  const pathPattern = /\b(lib|app|components|api|hooks|actions|pages|utils|types|storage|github|atc|orchestrat|decompos|escalat|gmail|notion|repos|work.?items)\b/g;
  let m: RegExpExecArray | null;
  while ((m = pathPattern.exec(text)) !== null) {
    keywords.add(m[1]);
  }
  return keywords;
}

// ─── Main grouping function ───────────────────────────────────────────────────

export function groupIntoSubPhases(
  items: WorkItem[],
  targetPhaseCount?: number
): SubPhase[] {
  if (items.length === 0) return [];

  // Determine target phase count
  const count = targetPhaseCount ?? (items.length >= 23 ? 3 : 2);
  const phaseCount = Math.max(1, Math.min(count, items.length));

  const ids = items.map(item => item.id);
  const itemById = new Map(items.map(item => [item.id, item]));

  // ── Step 1: Dependency clustering via union-find ──────────────────────────
  const { parent, rank } = makeUnionFind(ids);

  for (const item of items) {
    for (const dep of item.dependencies) {
      if (itemById.has(dep)) {
        ufUnion(parent, rank, item.id, dep);
      }
    }
  }

  // Build clusters: root → [item ids]
  const clusters = new Map<string, string[]>();
  for (const id of ids) {
    const root = ufFind(parent, id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(id);
  }

  let clusterList: string[][] = Array.from(clusters.values());

  // ── Step 2: Split oversized clusters by subsystem overlap ─────────────────
  const targetSize = Math.ceil(items.length / phaseCount);

  const splitClusters: string[][] = [];
  for (const cluster of clusterList) {
    if (cluster.length <= targetSize * 1.5) {
      splitClusters.push(cluster);
      continue;
    }
    // Split by subsystem keyword grouping
    const subsystemGroups = new Map<string, string[]>();
    const noKeyword: string[] = [];
    for (const id of cluster) {
      const item = itemById.get(id)!;
      const kws = Array.from(extractSubsystemKeywords(item));
      if (kws.length === 0) {
        noKeyword.push(id);
      } else {
        const primary = kws[0];
        if (!subsystemGroups.has(primary)) subsystemGroups.set(primary, []);
        subsystemGroups.get(primary)!.push(id);
      }
    }
    // Merge small subsystem groups until each chunk >= targetSize/2
    const chunks: string[][] = [];
    let current: string[] = [];
    for (const group of subsystemGroups.values()) {
      current.push(...group);
      if (current.length >= targetSize / 2) {
        chunks.push(current);
        current = [];
      }
    }
    if (noKeyword.length > 0) current.push(...noKeyword);
    if (current.length > 0) {
      if (chunks.length === 0) chunks.push(current);
      else chunks[chunks.length - 1].push(...current);
    }
    splitClusters.push(...(chunks.length > 0 ? chunks : [cluster]));
  }
  clusterList = splitClusters;

  // ── Step 3 & 4: Merge clusters into phaseCount phases ─────────────────────
  clusterList.sort((a, b) => b.length - a.length);

  const phases: string[][] = Array.from({ length: phaseCount }, () => []);
  for (const cluster of clusterList) {
    const smallest = phases.reduce((min, p, i) => p.length < phases[min].length ? i : min, 0);
    phases[smallest].push(...cluster);
  }

  // ── Risk tier balancing ───────────────────────────────────────────────────
  const phaseItemSets = phases.map(phaseIds => new Set(phaseIds));

  const highRiskIds = ids.filter(id => itemById.get(id)!.riskLevel === 'high');
  if (highRiskIds.length > 1 && phases.length > 1) {
    const highRiskInPhase0 = highRiskIds.filter(id => phaseItemSets[0].has(id));
    if (highRiskInPhase0.length === highRiskIds.length && highRiskIds.length >= 2) {
      const toMove = highRiskInPhase0.slice(Math.floor(highRiskInPhase0.length / 2));
      for (const id of toMove) {
        const idx = phases[0].indexOf(id);
        if (idx !== -1) phases[0].splice(idx, 1);
        const target = phases.slice(1).reduce((min, p, i) => p.length < phases.slice(1)[min].length ? i : min, 0);
        phases[target + 1].push(id);
      }
    }
  }

  // ── Build SubPhase objects ─────────────────────────────────────────────────
  const phaseIdList = phases.map((_, i) => `phase-${String.fromCharCode(97 + i)}`);
  const itemToPhase = new Map<string, string>();
  phases.forEach((phaseItems, i) => {
    for (const id of phaseItems) {
      itemToPhase.set(id, phaseIdList[i]);
    }
  });

  // ── Cross-phase dependency stitching ──────────────────────────────────────
  const phaseDepsMap = new Map<string, Set<string>>();
  for (const phaseId of phaseIdList) phaseDepsMap.set(phaseId, new Set());

  for (const item of items) {
    const itemPhase = itemToPhase.get(item.id);
    if (!itemPhase) continue;
    for (const dep of item.dependencies) {
      const depPhase = itemToPhase.get(dep);
      if (depPhase && depPhase !== itemPhase) {
        phaseDepsMap.get(itemPhase)!.add(depPhase);
      }
    }
  }

  // ── Circular cross-phase dependency detection and merging ─────────────────
  let merged = true;
  while (merged) {
    merged = false;
    const currentPhaseIds = Array.from(phaseDepsMap.keys());
    outerLoop: for (let i = 0; i < currentPhaseIds.length; i++) {
      for (let j = i + 1; j < currentPhaseIds.length; j++) {
        const pa = currentPhaseIds[i];
        const pb = currentPhaseIds[j];
        if (phaseDepsMap.get(pa)?.has(pb) && phaseDepsMap.get(pb)?.has(pa)) {
          const aIdx = phaseIdList.indexOf(pa);
          const bIdx = phaseIdList.indexOf(pb);
          if (aIdx === -1 || bIdx === -1) continue;
          phases[aIdx].push(...phases[bIdx]);
          phases.splice(bIdx, 1);
          phaseIdList.splice(bIdx, 1);
          itemToPhase.clear();
          phases.forEach((phaseItems, pi) => {
            for (const id of phaseItems) itemToPhase.set(id, phaseIdList[pi]);
          });
          phaseDepsMap.clear();
          for (const phaseId of phaseIdList) phaseDepsMap.set(phaseId, new Set());
          for (const item of items) {
            const itemPhase = itemToPhase.get(item.id);
            if (!itemPhase) continue;
            for (const dep of item.dependencies) {
              const depPhase = itemToPhase.get(dep);
              if (depPhase && depPhase !== itemPhase) {
                phaseDepsMap.get(itemPhase)!.add(depPhase);
              }
            }
          }
          merged = true;
          break outerLoop;
        }
      }
    }
  }

  // ── Assemble final SubPhase array ─────────────────────────────────────────
  return phaseIdList.map((phaseId, i) => ({
    id: phaseId,
    parentProjectId: '',
    name: phaseId,
    items: phases[i].map(id => itemById.get(id)!).filter(Boolean),
    dependencies: Array.from(phaseDepsMap.get(phaseId) ?? []),
  }));
}
