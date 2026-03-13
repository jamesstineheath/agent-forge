import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { getWorkItem, updateWorkItem } from "./work-items";
import { listRepos, getRepo } from "./repos";
import {
  readRepoFile,
  listRecentMergedPRs,
  createBranch,
  pushFile,
} from "./github";
import type { WorkItem, RepoConfig } from "./types";

export interface RepoContext {
  claudeMd: string;
  systemMap: string | null;
  adrs: Array<{ filename: string; content: string }>;
  recentPRs: Array<{ number: number; title: string; files: string[] }>;
}

export interface DispatchResult {
  workItemId: string;
  branch: string;
  handoffPath: string;
  startedAt: string;
}

async function findRepoByFullName(
  fullName: string
): Promise<RepoConfig | null> {
  const index = await listRepos();
  const entry = index.find((r) => r.fullName === fullName);
  if (!entry) return null;
  return getRepo(entry.id);
}

function slugifyBranchName(workItem: WorkItem): string {
  const slug = workItem.title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const prefix = workItem.title.toLowerCase().startsWith("fix") ? "fix" : "feat";
  return `${prefix}/${slug}`;
}

export async function fetchRepoContext(
  repo: RepoConfig
): Promise<RepoContext> {
  const [rawClaudeMd, systemMap] = await Promise.all([
    readRepoFile(repo.fullName, repo.claudeMdPath),
    repo.systemMapPath
      ? readRepoFile(repo.fullName, repo.systemMapPath)
      : Promise.resolve(null),
  ]);

  const claudeMd = rawClaudeMd ? rawClaudeMd.slice(0, 3000) : "";

  let adrs: Array<{ filename: string; content: string }> = [];
  if (repo.adrPath) {
    try {
      const listRes = await fetch(
        `https://api.github.com/repos/${repo.fullName}/contents/${repo.adrPath}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.GH_PAT}`,
            Accept: "application/vnd.github.v3+json",
          },
        }
      );
      if (listRes.ok) {
        const files = (await listRes.json()) as Array<{
          type: string;
          name: string;
          path: string;
        }>;
        const adrFiles = Array.isArray(files)
          ? files.filter((f) => f.type === "file" && f.name.endsWith(".md"))
          : [];
        const adrContents = await Promise.all(
          adrFiles.slice(0, 10).map(async (f) => {
            const content = await readRepoFile(repo.fullName, f.path);
            return { filename: f.name, content: content ? content.slice(0, 500) : "" };
          })
        );
        adrs = adrContents;
      }
    } catch {
      // ADRs are optional context
    }
  }

  let recentPRs: Array<{ number: number; title: string; files: string[] }> = [];
  try {
    const prs = await listRecentMergedPRs(repo.fullName, 5);
    recentPRs = prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      files: pr.files,
    }));
  } catch {
    // Recent PRs are optional context
  }

  return { claudeMd, systemMap, adrs, recentPRs };
}

const V3_TEMPLATE = `# [Title]

## Metadata
- **Branch:** \`feat/...\`
- **Priority:** high|medium|low
- **Model:** opus|sonnet
- **Type:** feature|fix|refactor|docs
- **Max Budget:** $X
- **Risk Level:** low|medium|high
- **Estimated files:** [comma-separated list]

## Context
[Why this work is needed, relevant architectural context]

## Requirements
[Numbered list of specific, testable requirements]

## Execution Steps

### Step 0: Branch setup
\`\`\`bash
git checkout main && git pull
git checkout -b feat/branch-name
\`\`\`

### Step 1: [Implementation step]
[Detailed instructions]

...

### Step N: Verification
\`\`\`bash
npx tsc --noEmit
npm run build
npm test
\`\`\`

### Step N+1: Commit, push, open PR
[Git commands and PR template]

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report`;

export async function generateHandoff(
  workItem: WorkItem,
  repoContext: RepoContext,
  repoConfig: RepoConfig
): Promise<string> {
  const adrSection =
    repoContext.adrs.length > 0
      ? `### Architecture Decision Records\n${repoContext.adrs
          .map((a) => `**${a.filename}**\n${a.content}`)
          .join("\n\n")}`
      : "";

  const prSection =
    repoContext.recentPRs.length > 0
      ? `### Recent Merged PRs (for coding pattern awareness)\n${repoContext.recentPRs
          .map(
            (pr) =>
              `- #${pr.number}: ${pr.title} (files: ${pr.files.slice(0, 5).join(", ")})`
          )
          .join("\n")}`
      : "";

  const systemMapSection = repoContext.systemMap
    ? `### System Map\n${repoContext.systemMap.slice(0, 2000)}`
    : "";

  const systemPrompt = `You are a dev orchestration agent generating handoff files for autonomous AI coding agents.

Generate a complete, executable v3 handoff file in markdown format. The handoff file will be executed by Claude Code in the target repository.

## V3 Handoff Format Template
${V3_TEMPLATE}

## Target Repository: ${repoConfig.fullName}

### CLAUDE.md (repository context)
${repoContext.claudeMd}

${systemMapSection}

${adrSection}

${prSection}

## Work Item to Implement
**Title:** ${workItem.title}
**Description:** ${workItem.description}
**Priority:** ${workItem.priority}
**Risk Level:** ${workItem.riskLevel}
**Complexity:** ${workItem.complexity}

Generate a complete v3 handoff file that an autonomous agent can execute to implement this work item. Be specific about implementation steps, include verification steps (tsc, build, tests), and include a session abort protocol.`;

  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system: systemPrompt,
    prompt: `Generate the v3 handoff file for: ${workItem.title}`,
    maxOutputTokens: 4000,
  });

  return text;
}

export async function dispatchWorkItem(
  workItemId: string
): Promise<DispatchResult> {
  // 1. Load work item, verify status is "ready"
  const workItem = await getWorkItem(workItemId);
  if (!workItem) throw new Error(`Work item ${workItemId} not found`);
  if (workItem.status !== "ready") {
    throw new Error(
      `Work item ${workItemId} is not in "ready" status (current: ${workItem.status})`
    );
  }

  // 2. Load repo config for the target repo
  const repoConfig = await findRepoByFullName(workItem.targetRepo);
  if (!repoConfig) {
    throw new Error(`Repo config not found for ${workItem.targetRepo}`);
  }

  try {
    // 3. Update work item status to "generating"
    await updateWorkItem(workItemId, { status: "generating" });

    // 4. Fetch repo context
    const repoContext = await fetchRepoContext(repoConfig);

    // 5. Generate handoff via Claude
    const handoffContent = await generateHandoff(workItem, repoContext, repoConfig);

    // 6. Determine branch name from work item
    const branch = slugifyBranchName(workItem);

    // 7. Create branch in target repo
    await createBranch(repoConfig.fullName, branch);

    // 8. Push handoff file to handoffs/ directory on the branch
    const handoffFilename = `${branch.replace("/", "-")}.md`;
    const handoffPath = `${repoConfig.handoffDir}${handoffFilename}`;
    await pushFile(
      repoConfig.fullName,
      branch,
      handoffPath,
      handoffContent,
      `handoff: ${workItem.title}`
    );

    // 9. Update work item with handoff content, branch name
    const now = new Date().toISOString();
    await updateWorkItem(workItemId, {
      handoff: {
        content: handoffContent,
        branch,
        budget: repoConfig.defaultBudget,
        generatedAt: now,
      },
    });

    // 10. Pushing to handoffs/ triggers Spec Review -> Execute Handoff pipeline
    //     No explicit workflow_dispatch needed.

    // 11. Update work item status to "executing", set execution.startedAt
    await updateWorkItem(workItemId, {
      status: "executing",
      execution: { startedAt: now },
    });

    // 12. Return dispatch result
    return { workItemId, branch, handoffPath, startedAt: now };
  } catch (error) {
    // On error, set work item status to "failed"
    await updateWorkItem(workItemId, {
      status: "failed",
      execution: {
        outcome: "failed",
        completedAt: new Date().toISOString(),
      },
    }).catch(() => {});

    throw error;
  }
}
