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
    mergeable: boolean | null;
    mergeable_state: string | null;
  };
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    htmlUrl: pr.html_url,
    mergedAt: pr.merged_at,
    mergeable: pr.mergeable,
    mergeableState: pr.mergeable_state,
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
    mergeable: boolean | null;
    mergeable_state: string | null;
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
