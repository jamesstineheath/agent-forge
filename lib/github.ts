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
}

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
  message: string
): Promise<void> {
  // Check if file exists to get its SHA
  const existingRes = await ghFetch(
    `${GITHUB_API}/repos/${repo}/contents/${path}?ref=${branch}`
  );
  let sha: string | undefined;
  if (existingRes.ok) {
    const existing = (await existingRes.json()) as { sha: string };
    sha = existing.sha;
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
  };
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    htmlUrl: pr.html_url,
    mergedAt: pr.merged_at,
  };
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
  }>;
  if (prs.length === 0) return null;
  const pr = prs[0];
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    htmlUrl: pr.html_url,
    mergedAt: pr.merged_at,
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
