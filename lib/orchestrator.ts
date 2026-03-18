import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { getWorkItem, updateWorkItem, listWorkItems } from "./work-items";
import { parseEstimatedFiles } from "./atc";
import { listRepos, getRepo } from "./repos";
import {
  readRepoFile,
  listRecentMergedPRs,
  createBranch,
  pushFile,
  getWorkflowRuns,
  triggerWorkflow,
  getPRByBranch,
} from "./github";
import { buildCachedPrompt } from "./prompt-cache";
import type { WorkItem, RepoConfig } from "./types";
import { FAST_LANE_BUDGET_SIMPLE, FAST_LANE_BUDGET_MODERATE } from "./types";

// --- Types ---

export interface RepoContext {
  claudeMd: string;
  systemMap: string | null;
  adrs: Array<{ title: string; status: string; decision: string }>;
  recentPRs: Array<{ title: string; files: string[] }>;
}

export interface DispatchResult {
  workItemId: string;
  branch: string;
  handoffPath: string;
  repo: string;
}

// --- Helpers ---

async function findRepoByFullName(fullName: string): Promise<RepoConfig | null> {
  const index = await listRepos();
  const entry = index.find((r) => r.fullName === fullName);
  if (!entry) return null;
  return getRepo(entry.id);
}

function slugifyBranch(workItem: WorkItem): string {
  const prefix = workItem.riskLevel === "low" ? "fix" : "feat";
  const slug = workItem.title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50);
  return `${prefix}/${slug}`;
}

function parseAdrSummary(content: string): { title: string; status: string; decision: string } {
  const lines = content.split("\n");
  const title = lines.find((l) => l.startsWith("# "))?.replace(/^# /, "").trim() ?? "Unknown";
  const statusMatch = content.match(/\*\*Status\*\*[:\s]+([^\n]+)/i);
  const status = statusMatch?.[1]?.trim() ?? "unknown";
  const decisionMatch = content.match(/## Decision\s*\n([\s\S]*?)(?:\n##|$)/i);
  const decision = decisionMatch?.[1]?.trim().slice(0, 200) ?? "";
  return { title, status, decision };
}

// --- Step 2: Repo context fetcher ---

export async function fetchRepoContext(repo: RepoConfig): Promise<RepoContext> {
  const [claudeMdRaw, systemMapRaw] = await Promise.all([
    readRepoFile(repo.fullName, repo.claudeMdPath),
    repo.systemMapPath ? readRepoFile(repo.fullName, repo.systemMapPath) : Promise.resolve(null),
  ]);

  const claudeMd = (claudeMdRaw ?? "").slice(0, 3000);
  const systemMap = systemMapRaw ?? null;

  // Fetch ADRs if path configured
  const adrs: Array<{ title: string; status: string; decision: string }> = [];
  if (repo.adrPath) {
    // List directory contents
    const adrListRes = await fetch(
      `https://api.github.com/repos/${repo.fullName}/contents/${repo.adrPath}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GH_PAT}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    if (adrListRes.ok) {
      const adrFiles = (await adrListRes.json()) as Array<{ name: string; path: string }>;
      const mdFiles = adrFiles.filter((f) => f.name.endsWith(".md")).slice(0, 10);
      const contents = await Promise.all(
        mdFiles.map((f) => readRepoFile(repo.fullName, f.path))
      );
      for (const content of contents) {
        if (content) adrs.push(parseAdrSummary(content));
      }
    }
  }

  // Recent merged PRs
  const recentPRsFull = await listRecentMergedPRs(repo.fullName, 5);
  const recentPRs = recentPRsFull.map((pr) => ({ title: pr.title, files: pr.files }));

  return { claudeMd, systemMap, adrs, recentPRs };
}

// --- Step 3: Handoff generator ---

const V3_FORMAT_TEMPLATE = `## v3 Handoff Format

\`\`\`markdown
# [Repo Name] -- [Task Title]

## Metadata
- **Branch:** \`feat/branch-name\`
- **Priority:** high|medium|low
- **Model:** opus|sonnet
- **Type:** feature|fix|refactor|docs
- **Max Budget:** $8
- **Risk Level:** low|medium|high
- **Estimated files:** path/to/file1.ts, path/to/file2.ts

## Context
[Background on what this task is and why it needs to be done. Include relevant existing code patterns.]

## Requirements
[Numbered list of specific, testable requirements]

## Execution Steps

### Step 0: Branch setup
\`\`\`bash
git checkout main && git pull
git checkout -b feat/branch-name
\`\`\`

### Step 1: [First implementation step]
[Detailed instructions with code examples where helpful]

### Step N: Verification
\`\`\`bash
npx tsc --noEmit
npm run build
npm test
\`\`\`

### Step N+1: Commit, push, open PR
\`\`\`bash
git add -A
git commit -m "feat: description"
git push origin feat/branch-name
gh pr create --title "..." --body "..."
\`\`\`

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report
\`\`\`
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: [branch-name]
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
\`\`\`
\`\`\`
`;

const ESCALATION_PROTOCOL = `## Escalation Protocol

If the executing agent encounters a blocker it cannot resolve autonomously (ambiguous requirements,
missing credentials, architectural decisions requiring human judgment, or repeated failures after
3 attempts), it should escalate by calling the Agent Forge escalation API:

\`\`\`bash
curl -X POST "\${AGENT_FORGE_URL}/api/escalations" \\
  -H "Authorization: Bearer \${AGENT_FORGE_API_SECRET}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "workItemId": "<work-item-id>",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["<list of files modified so far>"]
    }
  }'
\`\`\`

The AGENT_FORGE_API_SECRET and AGENT_FORGE_URL environment variables are provided in the execution
environment. This will notify the project owner via email and block the work item until resolved.

Generate a precise, actionable handoff file. Be specific about file paths, function signatures, and implementation details. The agent executing this handoff has no other context — the handoff must be self-contained.`;

/**
 * Static system content: instructions + v3 format template + escalation protocol.
 * Extracted to module scope so it is never rebuilt per call and is eligible for
 * Anthropic prompt caching as a stable prefix.
 */
const STATIC_SYSTEM_CONTENT = `You are a dev orchestration agent generating handoff files for autonomous AI agents.

Your task is to generate a complete, executable v3 handoff markdown file that an AI agent (Claude Code) will execute to implement a work item in a target repository.

${V3_FORMAT_TEMPLATE}

${ESCALATION_PROTOCOL}`;

function buildRepoContextBlock(repoContext: RepoContext): string {
  return `## Target Repository Context

### CLAUDE.md (truncated to 3000 chars)
${repoContext.claudeMd || "(not available)"}

### System Map
${repoContext.systemMap || "(not configured)"}

### Architecture Decision Records
${
  repoContext.adrs.length > 0
    ? repoContext.adrs
        .map((adr) => `- **${adr.title}** (${adr.status}): ${adr.decision}`)
        .join("\n")
    : "(none)"
}

### Recent Merged PRs (for coding pattern awareness)
${
  repoContext.recentPRs.length > 0
    ? repoContext.recentPRs
        .map((pr) => `- ${pr.title}\n  Files: ${pr.files.slice(0, 5).join(", ")}`)
        .join("\n")
    : "(none)"
}`;
}

export async function generateHandoff(
  workItem: WorkItem,
  repoContext: RepoContext,
  repoConfig: RepoConfig,
  siblingItems?: Array<{ title: string; branch: string; estimatedFiles: string[] }>
): Promise<string> {
  const repoContextBlock = buildRepoContextBlock(repoContext);

  const userPrompt = `Generate a v3 handoff file for the following work item:

**Title:** ${workItem.title}
**Description:** ${workItem.description}
**Priority:** ${workItem.priority}
**Risk Level:** ${workItem.riskLevel}
**Complexity:** ${workItem.complexity}
**Target Repo:** ${repoConfig.fullName}
**Handoff Directory:** ${repoConfig.handoffDir}
**Execute Workflow:** ${repoConfig.executeWorkflow}
**Budget:** $${repoConfig.defaultBudget}
${siblingItems && siblingItems.length > 0 ? `
**Concurrent Work in Same Repo:**
${siblingItems.map(s => `- "${s.title}" (branch: \`${s.branch}\`${s.estimatedFiles.length > 0 ? `, files: ${s.estimatedFiles.join(", ")}` : ""})`).join("\n")}

IMPORTANT: Avoid modifying the same files as concurrent work items listed above. If overlap is unavoidable, note it in the handoff so the executor can coordinate.
` : ""}
Generate the complete handoff markdown file now.`;

  // Use buildCachedPrompt to organize the static/dynamic content split
  const cachedPrompt = buildCachedPrompt(
    { enabled: true, staticSections: [STATIC_SYSTEM_CONTENT, repoContextBlock] },
    userPrompt
  );

  // Guard: ensure the static template is non-empty
  if (!STATIC_SYSTEM_CONTENT || STATIC_SYSTEM_CONTENT.length < 100) {
    throw new Error("STATIC_SYSTEM_CONTENT is unexpectedly empty");
  }

  // Structure the API call with two cache breakpoints via AI SDK providerOptions:
  // 1. Static instructions + template (never changes between calls)
  // 2. Repo context (semi-static — same for all work items targeting the same repo)
  // Work item details are in the user prompt (dynamic, not cached)
  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system: [
      {
        role: "system" as const,
        content: STATIC_SYSTEM_CONTENT,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      },
      {
        role: "system" as const,
        content: repoContextBlock,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      },
    ],
    prompt: cachedPrompt.dynamicSuffix,
  });

  return text;
}

// --- Direct-source metadata helper ---

function buildDirectSourceMetadata(workItem: WorkItem): string {
  const triggeredBy = workItem.triggeredBy ?? 'unknown';
  const budget = workItem.complexityHint === 'simple'
    ? String(FAST_LANE_BUDGET_SIMPLE)
    : workItem.complexityHint === 'moderate'
      ? String(FAST_LANE_BUDGET_MODERATE)
      : '5';
  return `<!-- source: direct -->\n<!-- triggeredBy: ${triggeredBy} -->\n<!-- budget: ${budget} -->\n\n`;
}

// --- Step 4: Dispatch flow ---

export async function dispatchWorkItem(workItemId: string): Promise<DispatchResult> {
  // 1. Load work item, verify status is "ready"
  const workItem = await getWorkItem(workItemId);
  if (!workItem) throw new Error(`Work item not found: ${workItemId}`);
  if (workItem.status !== "ready") {
    throw new Error(`Work item is not in "ready" status (current: ${workItem.status})`);
  }

  // 2. Load repo config for the target repo
  const repoConfig = await findRepoByFullName(workItem.targetRepo);
  if (!repoConfig) {
    throw new Error(`Repo not registered: ${workItem.targetRepo}`);
  }

  // 3. Update work item status to "generating"
  await updateWorkItem(workItemId, { status: "generating" });

  try {
    // 4. Fetch repo context
    const repoContext = await fetchRepoContext(repoConfig);

    // 4b. Fetch sibling items (executing/reviewing in same repo)
    const [executingSiblings, reviewingSiblings] = await Promise.all([
      listWorkItems({ status: "executing", targetRepo: workItem.targetRepo }),
      listWorkItems({ status: "reviewing", targetRepo: workItem.targetRepo }),
    ]);
    const siblingItems = [...executingSiblings, ...reviewingSiblings]
      .filter(s => s.id !== workItem.id)
      .map(s => ({
        title: s.title,
        branch: "", // Will be populated below
        estimatedFiles: [] as string[],
      }));
    // Enrich with handoff data
    for (const sibling of siblingItems) {
      const entry = [...executingSiblings, ...reviewingSiblings].find(e => e.title === sibling.title);
      if (entry) {
        const fullItem = await getWorkItem(entry.id);
        if (fullItem) {
          sibling.branch = fullItem.handoff?.branch ?? "";
          sibling.estimatedFiles = fullItem.handoff?.content
            ? parseEstimatedFiles(fullItem.handoff.content)
            : fullItem.execution?.filesModified ?? [];
        }
      }
    }

    // 5. Generate handoff via Claude
    let handoffContent = await generateHandoff(workItem, repoContext, repoConfig, siblingItems.length > 0 ? siblingItems : undefined);

    // 5a. Prepend source metadata for direct-source items
    if (workItem.source.type === 'direct') {
      handoffContent = buildDirectSourceMetadata(workItem) + handoffContent;
    }

    // 6. Determine branch name from work item
    const branchName = slugifyBranch(workItem);

    // 7. Check if branch already exists (e.g. from a prior 'skipped' run that
    //    actually succeeded). If a PR exists on that branch, reconcile to
    //    'reviewing' instead of re-creating the branch (which would fail with
    //    "Reference already exists").
    const existingPr = await getPRByBranch(repoConfig.fullName, branchName);
    if (existingPr) {
      await updateWorkItem(workItemId, {
        status: "reviewing",
        execution: {
          ...workItem.execution,
          prNumber: existingPr.number,
          prUrl: existingPr.htmlUrl,
        },
      });
      return {
        workItemId,
        branch: branchName,
        handoffPath: "",
        repo: repoConfig.fullName,
      };
    }

    // Create branch in target repo
    await createBranch(repoConfig.fullName, branchName);

    // 8. Push handoff file to handoffs/awaiting_handoff/ directory on the branch
    const handoffDir = repoConfig.handoffDir.endsWith("/")
      ? repoConfig.handoffDir
      : `${repoConfig.handoffDir}/`;
    const slug = branchName.replace(/^(feat|fix)\//, "");
    const handoffPath = `${handoffDir}${slug}.md`;

    await pushFile(
      repoConfig.fullName,
      branchName,
      handoffPath,
      handoffContent,
      `chore: add handoff for ${workItem.title}`
    );

    // 9. Update work item with handoff content, branch name
    await updateWorkItem(workItemId, {
      handoff: {
        content: handoffContent,
        branch: branchName,
        budget: repoConfig.defaultBudget,
        generatedAt: new Date().toISOString(),
      },
    });

    // 10. Verify Spec Review workflow triggered (GitHub Contents API push may not fire on:push)
    await new Promise(resolve => setTimeout(resolve, 10_000));
    const runs = await getWorkflowRuns(repoConfig.fullName, branchName, "tlm-spec-review.yml");
    const recentRun = runs.find(r => {
      const age = (Date.now() - new Date(r.createdAt).getTime()) / 1000;
      return age < 60;
    });
    if (!recentRun) {
      console.warn(`[orchestrator] Spec Review not triggered by push. Dispatching manually.`);
      await triggerWorkflow(
        repoConfig.fullName,
        "tlm-spec-review.yml",
        branchName,
        { handoff_file: handoffPath }
      );
    }

    // 11. Update work item status to "executing", set execution.startedAt
    await updateWorkItem(workItemId, {
      status: "executing",
      execution: {
        startedAt: new Date().toISOString(),
      },
    });

    // 12. Return dispatch result
    return {
      workItemId,
      branch: branchName,
      handoffPath,
      repo: repoConfig.fullName,
    };
  } catch (err) {
    // On any failure: set work item status to "failed"
    await updateWorkItem(workItemId, {
      status: "failed",
    }).catch(() => {});
    throw err;
  }
}
