const GITHUB_API = "https://api.github.com";

function githubHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.GH_PAT}`,
    Accept: "application/vnd.github.v3+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function checkRateLimit(response: Response): void {
  const remaining = response.headers.get("X-RateLimit-Remaining");
  if (remaining && parseInt(remaining) < 100) {
    console.warn(`GitHub rate limit low: ${remaining} requests remaining`);
  }
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
  headBranch: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface PR {
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
  headBranch: string;
  baseBranch: string;
  mergedAt: string | null;
}

// Read a file from a repo (returns content as string, or null if not found)
export async function readRepoFile(
  repo: string,
  path: string,
  branch?: string
): Promise<string | null> {
  const url = `${GITHUB_API}/repos/${repo}/contents/${path}${branch ? `?ref=${branch}` : ""}`;
  const response = await fetch(url, { headers: githubHeaders() });
  checkRateLimit(response);

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Failed to read ${path} from ${repo}: ${response.status}`
    );
  }

  const data = (await response.json()) as {
    type: string;
    content: string;
    encoding: string;
  };
  if (data.type !== "file") return null;

  return Buffer.from(data.content, "base64").toString("utf-8");
}

// List recent merged PRs (returns array of {number, title, files, mergedAt})
export async function listRecentMergedPRs(
  repo: string,
  count = 5
): Promise<MergedPR[]> {
  const url = `${GITHUB_API}/repos/${repo}/pulls?state=closed&per_page=${count * 2}&sort=updated&direction=desc`;
  const response = await fetch(url, { headers: githubHeaders() });
  checkRateLimit(response);

  if (!response.ok) {
    throw new Error(`Failed to list PRs for ${repo}: ${response.status}`);
  }

  const prs = (await response.json()) as Array<{
    number: number;
    title: string;
    merged_at: string | null;
  }>;
  const merged = prs.filter((pr) => pr.merged_at !== null).slice(0, count);

  const results = await Promise.all(
    merged.map(async (pr) => {
      const filesUrl = `${GITHUB_API}/repos/${repo}/pulls/${pr.number}/files?per_page=30`;
      const filesRes = await fetch(filesUrl, { headers: githubHeaders() });
      checkRateLimit(filesRes);

      if (!filesRes.ok) {
        return {
          number: pr.number,
          title: pr.title,
          files: [] as string[],
          mergedAt: pr.merged_at as string,
        };
      }

      const files = (await filesRes.json()) as Array<{ filename: string }>;
      return {
        number: pr.number,
        title: pr.title,
        files: files.map((f) => f.filename),
        mergedAt: pr.merged_at as string,
      };
    })
  );

  return results;
}

// Create a new branch from the repo's default branch
export async function createBranch(
  repo: string,
  branchName: string
): Promise<void> {
  const repoRes = await fetch(`${GITHUB_API}/repos/${repo}`, {
    headers: githubHeaders(),
  });
  checkRateLimit(repoRes);
  if (!repoRes.ok) {
    throw new Error(
      `Failed to get repo info for ${repo}: ${repoRes.status}`
    );
  }
  const repoData = (await repoRes.json()) as { default_branch: string };
  const defaultBranch = repoData.default_branch ?? "main";

  const refRes = await fetch(
    `${GITHUB_API}/repos/${repo}/git/ref/heads/${defaultBranch}`,
    { headers: githubHeaders() }
  );
  checkRateLimit(refRes);
  if (!refRes.ok) {
    throw new Error(
      `Failed to get ref for ${defaultBranch} in ${repo}: ${refRes.status}`
    );
  }
  const refData = (await refRes.json()) as { object: { sha: string } };
  const sha = refData.object.sha;

  const createRes = await fetch(`${GITHUB_API}/repos/${repo}/git/refs`, {
    method: "POST",
    headers: githubHeaders(),
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha }),
  });
  checkRateLimit(createRes);
  if (!createRes.ok) {
    const err = await createRes.json();
    throw new Error(
      `Failed to create branch ${branchName} in ${repo}: ${JSON.stringify(err)}`
    );
  }
}

// Push a file to a branch (create or update)
export async function pushFile(
  repo: string,
  branch: string,
  path: string,
  content: string,
  message: string
): Promise<void> {
  let sha: string | undefined;
  const getRes = await fetch(
    `${GITHUB_API}/repos/${repo}/contents/${path}?ref=${branch}`,
    { headers: githubHeaders() }
  );
  checkRateLimit(getRes);
  if (getRes.ok) {
    const existing = (await getRes.json()) as { sha: string };
    sha = existing.sha;
  }

  const body: Record<string, string> = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
  };
  if (sha) body.sha = sha;

  const putRes = await fetch(`${GITHUB_API}/repos/${repo}/contents/${path}`, {
    method: "PUT",
    headers: githubHeaders(),
    body: JSON.stringify(body),
  });
  checkRateLimit(putRes);
  if (!putRes.ok) {
    const err = await putRes.json();
    throw new Error(
      `Failed to push ${path} to ${repo}/${branch}: ${JSON.stringify(err)}`
    );
  }
}

// Trigger a workflow via workflow_dispatch
export async function triggerWorkflow(
  repo: string,
  workflowFile: string,
  branch: string,
  inputs?: Record<string, string>
): Promise<void> {
  const url = `${GITHUB_API}/repos/${repo}/actions/workflows/${workflowFile}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: githubHeaders(),
    body: JSON.stringify({ ref: branch, inputs: inputs ?? {} }),
  });
  checkRateLimit(res);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      `Failed to trigger workflow ${workflowFile} in ${repo}: ${err}`
    );
  }
}

// Get workflow run status for a branch
export async function getWorkflowRuns(
  repo: string,
  branch: string,
  workflowFile?: string
): Promise<WorkflowRun[]> {
  const url = workflowFile
    ? `${GITHUB_API}/repos/${repo}/actions/workflows/${workflowFile}/runs?branch=${branch}&per_page=10`
    : `${GITHUB_API}/repos/${repo}/actions/runs?branch=${branch}&per_page=10`;

  const res = await fetch(url, { headers: githubHeaders() });
  checkRateLimit(res);
  if (!res.ok) {
    throw new Error(
      `Failed to get workflow runs for ${repo}/${branch}: ${res.status}`
    );
  }

  const data = (await res.json()) as {
    workflow_runs: Array<{
      id: number;
      status: string;
      conclusion: string | null;
      head_branch: string;
      created_at: string;
      updated_at: string;
      html_url: string;
    }>;
  };

  return data.workflow_runs.map((run) => ({
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    headBranch: run.head_branch,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    htmlUrl: run.html_url,
  }));
}

// Get PR by branch name
export async function getPRByBranch(
  repo: string,
  branch: string
): Promise<PR | null> {
  const owner = repo.split("/")[0];
  const url = `${GITHUB_API}/repos/${repo}/pulls?head=${owner}:${branch}&state=all&per_page=1`;
  const res = await fetch(url, { headers: githubHeaders() });
  checkRateLimit(res);
  if (!res.ok) {
    throw new Error(
      `Failed to get PR for branch ${branch} in ${repo}: ${res.status}`
    );
  }

  const prs = (await res.json()) as Array<{
    number: number;
    title: string;
    state: string;
    html_url: string;
    head: { ref: string };
    base: { ref: string };
    merged_at: string | null;
  }>;
  if (!prs.length) return null;

  const pr = prs[0];
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    htmlUrl: pr.html_url,
    headBranch: pr.head.ref,
    baseBranch: pr.base.ref,
    mergedAt: pr.merged_at,
  };
}
