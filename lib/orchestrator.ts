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

export async function generateHandoff(
  workItem: WorkItem,
  repoContext: RepoContext,
  repoConfig: RepoConfig
): Promise<string> {
  const systemPrompt = `You are a dev orchestration agent generating handoff files for autonomous AI agents.

Your task is to generate a complete, executable v3 handoff markdown file that an AI agent (Claude Code) will execute to implement a work item in a target repository.

${V3_FORMAT_TEMPLATE}

## Target Repository Context

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
}

## Escalation Protocol

If the executing agent encounters a blocker it cannot resolve autonomously (ambiguous requirements,
missing credentials, architectural decisions requiring human judgment, or repeated failures after
3 attempts), it should escalate by calling the Agent Forge escalation API:

\`\`\`bash
curl -X POST "\${AGENT_FORGE_URL}/api/escalations" \\
  -H "Authorization: Bearer \${ESCALATION_SECRET}" \\
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

The ESCALATION_SECRET and AGENT_FORGE_URL environment variables are provided in the execution
environment. This will notify the project owner via email and block the work item until resolved.

Generate a precise, actionable handoff file. Be specific about file paths, function signatures, and implementation details. The agent executing this handoff has no other context — the handoff must be self-contained.`;

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

Generate the complete handoff markdown file now.`;

  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system: systemPrompt,
    prompt: userPrompt,
  });

  return text;
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

    // 5. Generate handoff via Claude
    const handoffContent = await generateHandoff(workItem, repoContext, repoConfig);

    // 6. Determine branch name from work item
    const branchName = slugifyBranch(workItem);

    // 7. Create branch in target repo
    await createBranch(repoConfig.fullName, branchName);

    // 8. Push handoff file to handoffs/ directory on the branch
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

    // 10. Note: pushing to handoffs/ triggers Spec Review -> Execute Handoff pipeline.
    //     No explicit workflow_dispatch needed.

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
