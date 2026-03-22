import type { HLOLifecycleState } from "./types";

const GITHUB_API = "https://api.github.com";

function headers(): HeadersInit {
  return {
    Authorization: `Bearer ${process.env.GH_PAT}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function ghFetch(url: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...options, headers: { ...headers(), ...options?.headers } });
  const remaining = res.headers.get("X-RateLimit-Remaining");
  if (remaining !== null && parseInt(remaining) < 100) {
    console.warn(`[github] Rate limit low: ${remaining} requests remaining`);
  }
  return res;
}

export interface MergedPR {
  number: number;
  title: string;
  files: string[];
  mergedAt: string;
}

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface PR {
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
  mergedAt: string | null;
  mergeable: boolean | null;
  mergeableState: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
}

// ── MCP Pipeline Operations ──────────────────────────────────────

export interface WorkflowRunDetail {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  branch: string | null;
  event: string;
  created_at: string;
  updated_at: string;
  url: string;
  run_attempt: number;
  jobs: WorkflowJob[];
}

export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps?: WorkflowStep[];
}

export interface WorkflowStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
}

export interface WorkflowRunSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  branch: string | null;
  event: string;
  created_at: string;
  updated_at: string;
  url: string;
  run_attempt: number;
}

export interface PRSummary {
  number: number;
  title: string;
  state: string;
  head: string;
  base: string;
  draft: boolean;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  url: string;
  user: string | null;
}

export interface DirectoryEntry {
  name: string;
  type: string;
  path: string;
  sha: string;
}

export async function listWorkflowRuns(
  repo: string,
  params: {
    workflow?: string;
    branch?: string;
    status?: string;
    perPage?: number;
  }
): Promise<{ total_count: number; workflow_runs: WorkflowRunSummary[] }> {
  const base = params.workflow
    ? `${GITHUB_API}/repos/${repo}/actions/workflows/${params.workflow}/runs`
    : `${GITHUB_API}/repos/${repo}/actions/runs`;

  const qs = new URLSearchParams();
  if (params.branch) qs.set("branch", params.branch);
  if (params.status) qs.set("status", params.status);
  qs.set("per_page", String(params.perPage ?? 10));

  const res = await ghFetch(`${base}?${qs}`);
  if (!res.ok) return { total_count: 0, workflow_runs: [] };

  const data = (await res.json()) as {
    total_count: number;
    workflow_runs: Array<{
      id: number; name: string; status: string; conclusion: string | null;
      head_branch: string | null; event: string; created_at: string;
      updated_at: string; html_url: string; run_attempt: number;
    }>;
  };

  return {
    total_count: data.total_count,
    workflow_runs: data.workflow_runs.map((r) => ({
      id: r.id, name: r.name, status: r.status, conclusion: r.conclusion,
      branch: r.head_branch, event: r.event, created_at: r.created_at,
      updated_at: r.updated_at, url: r.html_url, run_attempt: r.run_attempt,
    })),
  };
}

export async function getWorkflowRunDetail(
  repo: string,
  runId: number
): Promise<WorkflowRunDetail> {
  const [runRes, jobsRes] = await Promise.all([
    ghFetch(`${GITHUB_API}/repos/${repo}/actions/runs/${runId}`),
    ghFetch(`${GITHUB_API}/repos/${repo}/actions/runs/${runId}/jobs`),
  ]);

  if (!runRes.ok) throw new Error(`Failed to get run ${runId}: ${runRes.status}`);
  const run = (await runRes.json()) as {
    id: number; name: string; status: string; conclusion: string | null;
    head_branch: string | null; event: string; created_at: string;
    updated_at: string; html_url: string; run_attempt: number;
  };

  let jobs: WorkflowJob[] = [];
  if (jobsRes.ok) {
    const jobsData = (await jobsRes.json()) as {
      jobs: Array<{
        id: number; name: string; status: string; conclusion: string | null;
        started_at: string | null; completed_at: string | null;
        steps?: Array<{ name: string; status: string; conclusion: string | null; number: number }>;
      }>;
    };
    jobs = jobsData.jobs.map((j) => ({
      id: j.id, name: j.name, status: j.status, conclusion: j.conclusion,
      started_at: j.started_at, completed_at: j.completed_at,
      steps: j.steps?.map((s) => ({ name: s.name, status: s.status, conclusion: s.conclusion, number: s.number })),
    }));
  }

  return {
    id: run.id, name: run.name, status: run.status, conclusion: run.conclusion,
    branch: run.head_branch, event: run.event, created_at: run.created_at,
    updated_at: run.updated_at, url: run.html_url, run_attempt: run.run_attempt,
    jobs,
  };
}

export async function rerunWorkflow(repo: string, runId: number): Promise<void> {
  const res = await ghFetch(`${GITHUB_API}/repos/${repo}/actions/runs/${runId}/rerun`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to rerun workflow ${runId}: ${res.status} ${err}`);
  }
}

export async function rerunFailedJobs(repo: string, runId: number): Promise<void> {
  const res = await ghFetch(`${GITHUB_API}/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to rerun failed jobs for ${runId}: ${res.status} ${err}`);
  }
}

export async function listDirectory(
  repo: string,
  path: string,
  ref?: string
): Promise<DirectoryEntry[]> {
  const url = `${GITHUB_API}/repos/${repo}/contents/${path}${ref ? `?ref=${ref}` : ""}`;
  const res = await ghFetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return (data as Array<{ name: string; type: string; path: string; sha: string }>).map((f) => ({
    name: f.name, type: f.type, path: f.path, sha: f.sha,
  }));
}

export async function listPullRequests(
  repo: string,
  params: { state?: string; head?: string; perPage?: number }
): Promise<PRSummary[]> {
  const qs = new URLSearchParams();
  qs.set("state", params.state ?? "open");
  if (params.head) {
    // GitHub API requires "owner:branch" format for the head filter.
    // If just a branch name is passed, prepend the repo owner.
    const head = params.head.includes(":")
      ? params.head
      : `${repo.split("/")[0]}:${params.head}`;
    qs.set("head", head);
  }
  qs.set("per_page", String(params.perPage ?? 20));

  const res = await ghFetch(`${GITHUB_API}/repos/${repo}/pulls?${qs}`);
  if (!res.ok) return [];

  const prs = (await res.json()) as Array<{
    number: number; title: string; state: string; draft: boolean;
    head: { ref: string }; base: { ref: string };
    merged_at: string | null; created_at: string; updated_at: string;
    html_url: string; user: { login: string } | null;
  }>;

  return prs.map((pr) => ({
    number: pr.number, title: pr.title, state: pr.state,
    head: pr.head.ref, base: pr.base.ref, draft: pr.draft,
    merged_at: pr.merged_at, created_at: pr.created_at,
    updated_at: pr.updated_at, url: pr.html_url,
    user: pr.user?.login ?? null,
  }));
}

export async function getPullRequestChecks(
  repo: string,
  prNumber: number
): Promise<{ pr: { number: number; title: string; head: string }; checks: Array<{ name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null }> }> {
  const prRes = await ghFetch(`${GITHUB_API}/repos/${repo}/pulls/${prNumber}`);
  if (!prRes.ok) throw new Error(`Failed to get PR #${prNumber}: ${prRes.status}`);
  const pr = (await prRes.json()) as { number: number; title: string; head: { ref: string; sha: string } };

  const checksRes = await ghFetch(`${GITHUB_API}/repos/${repo}/commits/${pr.head.sha}/check-runs`);
  let checks: Array<{ name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null }> = [];
  if (checksRes.ok) {
    const data = (await checksRes.json()) as {
      check_runs: Array<{ name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null }>;
    };
    checks = data.check_runs.map((c) => ({
      name: c.name, status: c.status, conclusion: c.conclusion,
      started_at: c.started_at, completed_at: c.completed_at,
    }));
  }

  return { pr: { number: pr.number, title: pr.title, head: pr.head.ref }, checks };
}

const PIPELINE_WORKFLOWS = [
  "ci.yml", "tlm-spec-review.yml", "execute-handoff.yml",
  "tlm-review.yml", "handoff-orchestrator.yml", "ci-stuck-pr-monitor.yml",
];

export async function getPipelineHealth(
  repo: string
): Promise<Array<{ workflow: string; recent: WorkflowRunSummary[]; error?: string }>> {
  const results = await Promise.allSettled(
    PIPELINE_WORKFLOWS.map(async (wf) => {
      const data = await listWorkflowRuns(repo, { workflow: wf, perPage: 3 });
      return { workflow: wf, recent: data.workflow_runs };
    })
  );

  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return { workflow: PIPELINE_WORKFLOWS[i], recent: [], error: String(r.reason) };
  });
}

// ── Existing Functions ───────────────────────────────────────────

export async function readRepoFile(
  repo: string,
  path: string,
  branch?: string
): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${repo}/contents/${path}${branch ? `?ref=${branch}` : ""}`;
  const res = await ghFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    console.error(`[github] readRepoFile failed: ${res.status} ${res.statusText}`);
    return null;
  }
  const data = (await res.json()) as { content?: string; encoding?: string };
  if (data.encoding === "base64" && data.content) {
    return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8");
  }
  return null;
}

export async function listRecentMergedPRs(
  repo: string,
  count = 5
): Promise<MergedPR[]> {
  const url = `${GITHUB_API}/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${count * 2}`;
  const res = await ghFetch(url);
  if (!res.ok) return [];

  const prs = (await res.json()) as Array<{
    number: number;
    title: string;
    merged_at: string | null;
  }>;

  const merged = prs.filter((pr) => pr.merged_at !== null).slice(0, count);

  const results: MergedPR[] = [];
  for (const pr of merged) {
    const filesUrl = `${GITHUB_API}/repos/${repo}/pulls/${pr.number}/files?per_page=30`;
    const filesRes = await ghFetch(filesUrl);
    const files: string[] = [];
    if (filesRes.ok) {
      const filesData = (await filesRes.json()) as Array<{ filename: string }>;
      files.push(...filesData.map((f) => f.filename));
    }
    results.push({
      number: pr.number,
      title: pr.title,
      files,
      mergedAt: pr.merged_at!,
    });
  }

  return results;
}

export async function createBranch(repo: string, branchName: string): Promise<void> {
  // Get default branch SHA
  const repoRes = await ghFetch(`${GITHUB_API}/repos/${repo}`);
  if (!repoRes.ok) throw new Error(`Failed to fetch repo info: ${repoRes.status}`);
  const repoData = (await repoRes.json()) as { default_branch: string };
  const defaultBranch = repoData.default_branch;

  const refRes = await ghFetch(`${GITHUB_API}/repos/${repo}/git/ref/heads/${defaultBranch}`);
  if (!refRes.ok) throw new Error(`Failed to fetch default branch ref: ${refRes.status}`);
  const refData = (await refRes.json()) as { object: { sha: string } };
  const sha = refData.object.sha;

  const createRes = await ghFetch(`${GITHUB_API}/repos/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha }),
  });
  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Failed to create branch: ${createRes.status} ${err}`);
  }
}

export async function pushFile(
  repo: string,
  branch: string,
  path: string,
  content: string,
  message: string,
  options?: { skipIfUnchanged?: boolean }
): Promise<{ pushed: boolean }> {
  // Check if file exists to get its SHA and content
  const existingRes = await ghFetch(
    `${GITHUB_API}/repos/${repo}/contents/${path}?ref=${branch}`
  );
  let sha: string | undefined;
  if (existingRes.ok) {
    const existing = (await existingRes.json()) as { sha: string; content?: string; encoding?: string };
    sha = existing.sha;

    // Skip push if content is unchanged
    if (options?.skipIfUnchanged && existing.encoding === "base64" && existing.content) {
      const existingContent = Buffer.from(existing.content.replace(/\n/g, ""), "base64").toString("utf-8");
      if (existingContent === content) {
        return { pushed: false };
      }
    }
  }

  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch,
  };
  if (sha) body.sha = sha;

  const res = await ghFetch(`${GITHUB_API}/repos/${repo}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to push file: ${res.status} ${err}`);
  }
  return { pushed: true };
}

export async function triggerWorkflow(
  repo: string,
  workflowFile: string,
  branch: string,
  inputs?: Record<string, string>
): Promise<void> {
  const res = await ghFetch(
    `${GITHUB_API}/repos/${repo}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      body: JSON.stringify({ ref: branch, inputs: inputs ?? {} }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to trigger workflow: ${res.status} ${err}`);
  }
}

export async function getWorkflowRuns(
  repo: string,
  branch: string,
  workflowFile?: string
): Promise<WorkflowRun[]> {
  const base = workflowFile
    ? `${GITHUB_API}/repos/${repo}/actions/workflows/${workflowFile}/runs`
    : `${GITHUB_API}/repos/${repo}/actions/runs`;
  const url = `${base}?branch=${encodeURIComponent(branch)}&per_page=10`;
  const res = await ghFetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as {
    workflow_runs: Array<{
      id: number;
      status: string;
      conclusion: string | null;
      created_at: string;
      updated_at: string;
      html_url: string;
    }>;
  };
  return data.workflow_runs.map((r) => ({
    id: r.id,
    status: r.status,
    conclusion: r.conclusion,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    htmlUrl: r.html_url,
  }));
}

export async function getPRFiles(repo: string, prNumber: number): Promise<string[]> {
  const url = `${GITHUB_API}/repos/${repo}/pulls/${prNumber}/files?per_page=100`;
  const res = await ghFetch(url);
  if (!res.ok) return [];
  const files = (await res.json()) as Array<{ filename: string }>;
  return files.map(f => f.filename);
}

export async function getPRFilesDetailed(
  repo: string,
  prNumber: number
): Promise<Array<{ filename: string; status: string; additions: number; deletions: number }>> {
  const url = `${GITHUB_API}/repos/${repo}/pulls/${prNumber}/files?per_page=100`;
  const res = await ghFetch(url);
  if (!res.ok) return [];
  const files = (await res.json()) as Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
  return files.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
  }));
}

export async function getPRByNumber(repo: string, prNumber: number): Promise<PR | null> {
  const url = `${GITHUB_API}/repos/${repo}/pulls/${prNumber}`;
  const res = await ghFetch(url);
  if (!res.ok) return null;
  const pr = (await res.json()) as {
    number: number;
    title: string;
    state: string;
    html_url: string;
    merged_at: string | null;
    mergeable: boolean | null;
    mergeable_state: string | null;
    additions: number;
    deletions: number;
    changed_files: number;
  };
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    htmlUrl: pr.html_url,
    mergedAt: pr.merged_at,
    mergeable: pr.mergeable,
    mergeableState: pr.mergeable_state,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
  };
}

/**
 * Check if a PR has been flagged for human review by TLM Code Review.
 * Returns true if any review comment contains "FLAG_FOR_HUMAN".
 */
export async function isPRFlaggedForHuman(repo: string, prNumber: number): Promise<boolean> {
  const url = `${GITHUB_API}/repos/${repo}/pulls/${prNumber}/reviews?per_page=20`;
  const res = await ghFetch(url);
  if (!res.ok) return false;
  const reviews = (await res.json()) as Array<{ body: string | null }>;
  return reviews.some((r) => r.body?.includes("FLAG_FOR_HUMAN") ?? false);
}

/**
 * Merge a PR using the GitHub API with squash method.
 * Uses admin override headers to bypass failed status checks (e.g., TLM review).
 */
export async function mergePR(
  repo: string,
  prNumber: number
): Promise<{ merged: boolean; error?: string }> {
  const res = await ghFetch(
    `${GITHUB_API}/repos/${repo}/pulls/${prNumber}/merge`,
    {
      method: "PUT",
      body: JSON.stringify({ merge_method: "squash" }),
      headers: { "X-GitHub-Api-Version": "2022-11-28" },
    }
  );

  if (res.ok || res.status === 200) {
    return { merged: true };
  }

  const err = await res.text();
  return { merged: false, error: `${res.status} ${err}` };
}

export async function getPRByBranch(repo: string, branch: string): Promise<PR | null> {
  const url = `${GITHUB_API}/repos/${repo}/pulls?head=${encodeURIComponent(
    `${repo.split("/")[0]}:${branch}`
  )}&state=all&per_page=5`;
  const res = await ghFetch(url);
  if (!res.ok) return null;
  const prs = (await res.json()) as Array<{
    number: number;
    title: string;
    state: string;
    html_url: string;
    merged_at: string | null;
    mergeable: boolean | null;
    mergeable_state: string | null;
    additions: number;
    deletions: number;
    changed_files: number;
  }>;
  if (prs.length === 0) return null;
  const pr = prs[0];
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    htmlUrl: pr.html_url,
    mergedAt: pr.merged_at,
    mergeable: pr.mergeable ?? null,
    mergeableState: pr.mergeable_state ?? null,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
  };
}

export async function listBranches(repo: string): Promise<string[]> {
  const repoRes = await ghFetch(`${GITHUB_API}/repos/${repo}`);
  if (!repoRes.ok) return [];
  const repoData = (await repoRes.json()) as { default_branch: string };
  const defaultBranch = repoData.default_branch;

  const url = `${GITHUB_API}/repos/${repo}/branches?per_page=100`;
  const res = await ghFetch(url);
  if (!res.ok) return [];
  const branches = (await res.json()) as Array<{ name: string }>;
  return branches.map((b) => b.name).filter((name) => name !== defaultBranch);
}

export async function deleteBranch(repo: string, branch: string): Promise<boolean> {
  const res = await ghFetch(
    `${GITHUB_API}/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    { method: "DELETE" }
  );
  if (res.status === 204) return true;
  console.error(`[github] deleteBranch failed for ${repo}/${branch}: ${res.status}`);
  return false;
}

export async function getBranchLastCommitDate(
  repo: string,
  branch: string
): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=1`;
  const res = await ghFetch(url);
  if (!res.ok) return null;
  const commits = (await res.json()) as Array<{
    commit: { committer: { date: string } };
  }>;
  if (commits.length === 0) return null;
  return commits[0].commit.committer.date;
}

export async function listBranchCommits(
  repo: string,
  branch: string,
  perPage = 30
): Promise<Array<{ sha: string; message: string; timestamp: string }>> {
  const url = `${GITHUB_API}/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}`;
  const res = await ghFetch(url);
  if (!res.ok) return [];
  const commits = (await res.json()) as Array<{
    sha: string;
    commit: { message: string; committer: { date: string } };
  }>;
  return commits.map((c) => ({
    sha: c.sha.slice(0, 7),
    message: c.commit.message.split("\n")[0],
    timestamp: c.commit.committer.date,
  }));
}

export async function createGitHubRepo(options: {
  name: string;
  private?: boolean;
  description?: string;
  autoInit?: boolean;
}): Promise<{ full_name: string; html_url: string; id: number; default_branch: string }> {
  const res = await ghFetch(`${GITHUB_API}/user/repos`, {
    method: "POST",
    body: JSON.stringify({
      name: options.name,
      private: options.private ?? false,
      description: options.description,
      auto_init: options.autoInit ?? true,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create repo: ${res.status} ${err}`);
  }
  const data = (await res.json()) as {
    full_name: string;
    html_url: string;
    id: number;
    default_branch: string;
  };
  return data;
}

export async function getRepoPublicKey(
  owner: string,
  repo: string
): Promise<{ key_id: string; key: string }> {
  const res = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/secrets/public-key`
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to get repo public key: ${res.status} ${err}`);
  }
  return (await res.json()) as { key_id: string; key: string };
}

export async function setRepoSecret(
  owner: string,
  repo: string,
  secretName: string,
  encryptedValue: string,
  keyId: string
): Promise<void> {
  const res = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/secrets/${secretName}`,
    {
      method: "PUT",
      body: JSON.stringify({
        encrypted_value: encryptedValue,
        key_id: keyId,
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to set secret ${secretName}: ${res.status} ${err}`);
  }
}

export async function setActionsPermissions(
  owner: string,
  repo: string
): Promise<void> {
  const res = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/permissions`,
    {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        allowed_actions: "all",
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to set actions permissions: ${res.status} ${err}`);
  }
}

export async function getCommitsBehindMain(
  owner: string,
  repo: string,
  branch: string
): Promise<number> {
  try {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/compare/${encodeURIComponent(branch)}...main`;
    const res = await ghFetch(url);
    if (!res.ok) return 0;
    const data = (await res.json()) as { behind_by?: number };
    return typeof data.behind_by === "number" ? data.behind_by : 0;
  } catch {
    return 0;
  }
}

/**
 * Check whether a branch has been merged into main (via any PR).
 * Uses the GitHub compare API: if the branch is "behind" or "identical" to main,
 * all branch commits are already in main. A 404 means the branch was deleted
 * (likely merged and cleaned up), which we treat as merged.
 *
 * Useful when work items track a secondary PR after the original merged PR.
 */
export async function isBranchMergedIntoMain(
  owner: string,
  repo: string,
  branchName: string
): Promise<boolean> {
  try {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/compare/main...${encodeURIComponent(branchName)}`;
    const res = await ghFetch(url);
    if (!res.ok) {
      // Branch may be deleted (already merged and cleaned up)
      if (res.status === 404) return true;
      return false;
    }
    const data = (await res.json()) as { status?: string };
    // "behind" means all branch commits are already in main
    // "identical" means branch == main
    return data.status === "behind" || data.status === "identical";
  } catch {
    return false;
  }
}

export async function setDefaultWorkflowPermissions(
  owner: string,
  repo: string
): Promise<void> {
  const res = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/permissions/workflow`,
    {
      method: "PUT",
      body: JSON.stringify({
        default_workflow_permissions: "write",
        can_approve_pull_request_reviews: true,
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to set workflow permissions: ${res.status} ${err}`);
  }
}

export async function deleteGitHubRepo(
  owner: string,
  repo: string
): Promise<void> {
  const res = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}`,
    { method: "DELETE" }
  );
  if (!res.ok && res.status !== 404) {
    const err = await res.text();
    throw new Error(`Failed to delete repo: ${res.status} ${err}`);
  }
}

export async function setBranchProtection(
  owner: string,
  repo: string,
  branch: string
): Promise<void> {
  const res = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/branches/${branch}/protection`,
    {
      method: "PUT",
      body: JSON.stringify({
        required_pull_request_reviews: {
          required_approving_review_count: 0,
          dismiss_stale_reviews: false,
        },
        enforce_admins: false,
        required_status_checks: null,
        restrictions: null,
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to set branch protection: ${res.status} ${err}`);
  }
}

export async function getPRLifecycleState(
  owner: string,
  repo: string,
  prNumber: number
): Promise<HLOLifecycleState | null> {
  try {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`;
    const res = await ghFetch(url);

    if (!res.ok) {
      return null;
    }

    const comments = (await res.json()) as Array<{ body: string }>;

    // Iterate in reverse to find the most recent lifecycle comment
    for (let i = comments.length - 1; i >= 0; i--) {
      const body = comments[i].body ?? "";
      const startMarker = "<!-- LIFECYCLE-JSON:";
      const endMarker = ":LIFECYCLE-JSON -->";

      const startIdx = body.indexOf(startMarker);
      if (startIdx === -1) continue;

      const jsonStart = startIdx + startMarker.length;
      const endIdx = body.indexOf(endMarker, jsonStart);
      if (endIdx === -1) continue;

      const jsonStr = body.slice(jsonStart, endIdx).trim();

      try {
        const parsed = JSON.parse(jsonStr) as HLOLifecycleState;
        // Basic validation: ensure it has at least a 'currentState' field
        if (parsed && typeof parsed.currentState === "string") {
          return parsed;
        }
      } catch {
        // Malformed JSON — keep looking at older comments
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// --- Merge conflict recovery utilities ---

export interface MergeabilityResult {
  mergeable: boolean | null;
  mergeableState: string | null;
}

export async function getPRMergeability(
  repo: string,
  prNumber: number
): Promise<MergeabilityResult> {
  const pr = await getPRByNumber(repo, prNumber);
  if (!pr) return { mergeable: null, mergeableState: null };

  // GitHub computes mergeable lazily — if null, wait briefly and retry once
  if (pr.mergeable === null) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const retry = await getPRByNumber(repo, prNumber);
    if (!retry) return { mergeable: null, mergeableState: null };
    return { mergeable: retry.mergeable, mergeableState: retry.mergeableState };
  }

  return { mergeable: pr.mergeable, mergeableState: pr.mergeableState };
}

export async function rebasePR(
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ success: boolean; error?: string }> {
  try {
    // GET the PR to obtain the current head SHA
    const prRes = await ghFetch(
      `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`
    );

    if (!prRes.ok) {
      const text = await prRes.text();
      return {
        success: false,
        error: `Failed to fetch PR #${prNumber}: ${prRes.status} ${text}`,
      };
    }

    const prData = (await prRes.json()) as { head: { sha: string } };
    const expectedHeadSha = prData.head.sha;

    // PUT update-branch with expected_head_sha
    const updateRes = await ghFetch(
      `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/update-branch`,
      {
        method: "PUT",
        body: JSON.stringify({ expected_head_sha: expectedHeadSha }),
      }
    );

    if (updateRes.status === 202) {
      return { success: true };
    }

    if (updateRes.status === 409) {
      const body = (await updateRes.json().catch(() => ({}))) as { message?: string };
      return {
        success: false,
        error: `Merge conflict rebasing PR #${prNumber}: ${body.message ?? "conflict"}`,
      };
    }

    const errText = await updateRes.text();
    return {
      success: false,
      error: `Unexpected response rebasing PR #${prNumber}: ${updateRes.status} ${errText}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `rebasePR error: ${message}` };
  }
}

const CLOSE_REASON_LABELS: Record<string, string> = {
  sla_timeout: "SLA timeout (24h with no progress)",
  superseded: "Superseded by a newer work item",
  merge_conflicts: "Unresolvable merge conflicts",
  stale: "Stale — no activity for an extended period",
};

export async function closePRWithReason(
  owner: string,
  repo: string,
  prNumber: number,
  reason: "sla_timeout" | "superseded" | "merge_conflicts" | "stale",
  details: string,
  supersededBy?: number
): Promise<void> {
  // Fetch PR details to get branch name
  const prRes = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`
  );
  if (!prRes.ok) {
    const err = await prRes.text();
    throw new Error(`Failed to fetch PR #${prNumber}: ${prRes.status} ${err}`);
  }
  const pr = (await prRes.json()) as { head: { ref: string } };
  const branchName = pr.head.ref;

  // Build and post structured comment
  const timestamp = new Date().toISOString();
  const reasonLabel = CLOSE_REASON_LABELS[reason] ?? reason;
  const supersededLine =
    supersededBy != null ? `\n**Superseded by:** #${supersededBy}\n` : "";
  const commentBody = [
    "## PR Auto-Closed",
    "",
    `**Reason:** ${reasonLabel}`,
    "",
    details,
    supersededLine,
    `**Closed at:** ${timestamp}`,
  ].join("\n");

  const commentRes = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    {
      method: "POST",
      body: JSON.stringify({ body: commentBody }),
    }
  );
  if (!commentRes.ok) {
    const err = await commentRes.text();
    throw new Error(
      `Failed to post comment on PR #${prNumber}: ${commentRes.status} ${err}`
    );
  }

  // Close the PR
  const closeRes = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`,
    {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    }
  );
  if (!closeRes.ok) {
    const err = await closeRes.text();
    throw new Error(
      `Failed to close PR #${prNumber}: ${closeRes.status} ${err}`
    );
  }

  // Delete branch if no other open PRs reference it
  const otherPRsRes = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branchName}`)}&state=open`
  );
  if (otherPRsRes.ok) {
    const otherPRs = (await otherPRsRes.json()) as Array<{ number: number }>;
    if (Array.isArray(otherPRs) && otherPRs.length === 0) {
      const deleteRes = await ghFetch(
        `${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branchName)}`,
        { method: "DELETE" }
      );
      if (!deleteRes.ok && deleteRes.status !== 422) {
        console.warn(
          `[github] closePRWithReason: could not delete branch ${branchName}: ${deleteRes.status}`
        );
      }
    }
  } else {
    console.warn(
      `[github] closePRWithReason: could not check for other PRs on branch ${branchName}: ${otherPRsRes.status}`
    );
  }
}

/**
 * Read the raw text content of a file from a GitHub repository.
 * @throws Error if the file is not found or content cannot be decoded.
 */
export async function readFileContent(
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<string> {
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const res = await ghFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${qs}`,
  );

  if (!res.ok) {
    throw new Error(
      `File ${path} not found in ${owner}/${repo}: ${res.status}`,
    );
  }

  const data = (await res.json()) as { type?: string; content?: string };

  if (data.type !== "file") {
    throw new Error(`Path ${path} is not a file in ${owner}/${repo}`);
  }

  if (!data.content) {
    throw new Error(`File ${path} in ${owner}/${repo} has no content`);
  }

  return Buffer.from(data.content, "base64").toString("utf-8");
}

/**
 * Convenience wrapper for readFileContent that accepts "owner/repo" format.
 * Returns null instead of throwing if file not found.
 */
export async function getFileContent(
  repo: string,
  path: string,
  ref?: string,
): Promise<string | null> {
  const [owner, repoName] = repo.includes("/")
    ? repo.split("/")
    : ["jamesstineheath", repo];
  try {
    return await readFileContent(owner, repoName, path, ref);
  } catch {
    return null;
  }
}
