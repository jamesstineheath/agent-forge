import _sodium from 'libsodium-wrappers';
import {
  BootstrapOptions,
  BootstrapResult,
  BootstrapStep,
  PreflightChecklistItem,
} from './types';
import { getTemplateFiles } from './templates';
import {
  createGitHubRepo,
  deleteGitHubRepo,
  pushFile,
  getRepoPublicKey,
  setRepoSecret,
  setActionsPermissions,
  setDefaultWorkflowPermissions,
  setBranchProtection,
} from './github';
import { createRepo, isRepoRegistered } from './repos';

const ALL_STEP_NAMES = [
  'check-duplicate',
  'create-repo',
  'push-workflows',
  'push-claude-md',
  'set-secrets',
  'register-repo',
  'enable-actions',
  'branch-protection',
  'vercel-project',
] as const;

function skipRemaining(
  afterStep: string,
  steps: BootstrapStep[]
) {
  const idx = ALL_STEP_NAMES.indexOf(afterStep as (typeof ALL_STEP_NAMES)[number]);
  for (let i = idx + 1; i < ALL_STEP_NAMES.length; i++) {
    steps.push({ name: ALL_STEP_NAMES[i], status: 'skipped' });
  }
}

function buildChecklist(
  options: BootstrapOptions,
  steps: BootstrapStep[]
): PreflightChecklistItem[] {
  const items: PreflightChecklistItem[] = [];
  const owner = process.env.GITHUB_OWNER ?? 'jamesstineheath';

  // Always needed
  items.push({
    category: 'secret',
    description: `Verify ANTHROPIC_API_KEY is set in ${owner}/${options.repoName} repo secrets`,
    required: true,
  });

  if (!process.env.AGENT_FORGE_API_SECRET) {
    items.push({
      category: 'secret',
      description: `Set AGENT_FORGE_API_SECRET in ${owner}/${options.repoName} repo secrets for pipeline callbacks`,
      required: true,
    });
  }

  if (!process.env.AGENT_FORGE_URL) {
    items.push({
      category: 'env-var',
      description: `Set AGENT_FORGE_URL in ${owner}/${options.repoName} repo secrets (e.g. https://agent-forge-phi.vercel.app)`,
      required: true,
    });
  }

  items.push({
    category: 'secret',
    description: `Set GH_PAT in ${owner}/${options.repoName} repo secrets (fine-grained PAT with contents:write + pull_requests:write)`,
    required: true,
  });

  if (options.pipelineLevel === 'full-tlm') {
    items.push({
      category: 'manual',
      description: `Create docs/tlm-memory.md in ${owner}/${options.repoName} for TLM agent shared memory`,
      required: false,
    });
  }

  if (options.createVercelProject) {
    const vercelFailed = steps.some(s => s.name === 'vercel-project' && s.status === 'failed');
    if (vercelFailed) {
      items.push({
        category: 'service',
        description: `Manually create Vercel project for ${owner}/${options.repoName} — automated setup failed`,
        required: true,
      });
    }
    items.push({
      category: 'env-var',
      description: 'Verify Vercel environment variables are correctly set for all deployment environments',
      required: true,
    });
  }

  items.push({
    category: 'manual',
    description: `Create CLAUDE.md in ${owner}/${options.repoName} with project-specific instructions`,
    required: false,
  });

  items.push({
    category: 'manual',
    description: `Configure GitHub webhook at ${owner}/${options.repoName} → Settings → Webhooks pointing to Agent Forge /api/webhooks/github`,
    required: true,
  });

  return items;
}

async function createVercelProject(
  repoName: string,
  owner: string,
  options: BootstrapOptions
): Promise<string> {
  const vercelToken = process.env.VERCEL_TOKEN;
  if (!vercelToken) {
    throw new Error('VERCEL_TOKEN env var is required for Vercel project creation');
  }

  const teamId = process.env.VERCEL_TEAM_ID;
  const baseUrl = 'https://api.vercel.com';
  const queryParams = teamId ? `?teamId=${teamId}` : '';

  // Create project linked to GitHub repo
  const createRes = await fetch(`${baseUrl}/v10/projects${queryParams}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${vercelToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: repoName,
      framework: options.vercelFramework ?? 'nextjs',
      gitRepository: {
        type: 'github',
        repo: `${owner}/${repoName}`,
      },
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Vercel project creation failed: ${createRes.status} ${err}`);
  }

  const project = (await createRes.json()) as { id: string; name: string };

  // Seed environment variables from template
  const envVars: Record<string, string> = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
    AUTH_SECRET: '',
    BLOB_READ_WRITE_TOKEN: '',
    ...options.vercelEnvVars,
  };

  const envPayload = Object.entries(envVars)
    .filter(([, v]) => v !== '')
    .map(([key, value]) => ({
      key,
      value,
      type: 'encrypted' as const,
      target: ['production', 'preview', 'development'],
    }));

  if (envPayload.length > 0) {
    await fetch(`${baseUrl}/v10/projects/${project.id}/env${queryParams}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${vercelToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(envPayload),
    });
  }

  return `https://vercel.com/${teamId ? `team` : owner}/${project.name}`;
}

export async function bootstrapRepo(
  repoName: string,
  options: BootstrapOptions
): Promise<BootstrapResult> {
  const steps: BootstrapStep[] = [];
  const owner = process.env.GITHUB_OWNER ?? 'jamesstineheath';
  const progress = options.onProgress ?? (() => {});

  const fail = (result: Partial<BootstrapResult>): BootstrapResult => ({
    repoUrl: '',
    repoId: 0,
    registrationId: '',
    steps,
    checklist: buildChecklist(options, steps),
    ...result,
  });

  // Step 0: Check for duplicate registration
  progress('check-duplicate', 'start');
  try {
    const alreadyRegistered = await isRepoRegistered(`${owner}/${repoName}`);
    if (alreadyRegistered) {
      steps.push({
        name: 'check-duplicate',
        status: 'failed',
        detail: `Repository ${owner}/${repoName} is already registered. Use the repos UI to manage it.`,
      });
      skipRemaining('check-duplicate', steps);
      progress('check-duplicate', 'done');
      return fail({});
    }
    steps.push({ name: 'check-duplicate', status: 'success' });
    progress('check-duplicate', 'done');
  } catch (err) {
    steps.push({
      name: 'check-duplicate',
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    skipRemaining('check-duplicate', steps);
    progress('check-duplicate', 'done');
    return fail({});
  }

  // Step 1: Create GitHub repo
  let repoUrl = '';
  let repoId = 0;
  let defaultBranch = 'main';

  progress('create-repo', 'start');
  try {
    const repoResult = await createGitHubRepo({
      name: repoName,
      private: options.isPrivate ?? false,
      description: options.description,
      autoInit: true,
    });
    repoUrl = repoResult.html_url;
    repoId = repoResult.id;
    defaultBranch = repoResult.default_branch;
    steps.push({ name: 'create-repo', status: 'success', detail: repoResult.full_name });
    progress('create-repo', 'done');
  } catch (err) {
    steps.push({
      name: 'create-repo',
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    skipRemaining('create-repo', steps);
    progress('create-repo', 'done');
    return fail({});
  }

  // Helper to clean up on failure after repo creation
  const cleanupAndFail = async (result: Partial<BootstrapResult>): Promise<BootstrapResult> => {
    try {
      await deleteGitHubRepo(owner, repoName);
      steps.push({ name: 'cleanup', status: 'success', detail: 'Deleted partially configured repo' });
    } catch {
      steps.push({ name: 'cleanup', status: 'failed', detail: 'Could not delete partial repo — manual cleanup required' });
    }
    return fail(result);
  };

  // Small delay for GitHub to initialize the repo
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Step 2: Push pipeline workflow files
  progress('push-workflows', 'start');
  try {
    const templateFiles = await getTemplateFiles(options.pipelineLevel);
    for (const file of templateFiles) {
      await pushFile(
        `${owner}/${repoName}`,
        defaultBranch,
        file.path,
        file.content,
        `chore: add pipeline file ${file.path}`
      );
    }
    steps.push({
      name: 'push-workflows',
      status: 'success',
      detail: `Pushed ${options.pipelineLevel === 'full-tlm' ? '4' : '1'} workflow files (TLM actions referenced cross-repo)`,
    });
    progress('push-workflows', 'done');
  } catch (err) {
    steps.push({
      name: 'push-workflows',
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    skipRemaining('push-workflows', steps);
    progress('push-workflows', 'done');
    return cleanupAndFail({ repoUrl, repoId });
  }

  // Step 3: Push a starter CLAUDE.md
  progress('push-claude-md', 'start');
  try {
    const claudeMd = [
      `# ${repoName}`,
      '',
      '> Project-specific instructions for Claude Code.',
      '',
      '## Pipeline',
      '',
      `This repo is managed by Agent Forge. TLM agents run via cross-repo references to \`jamesstineheath/agent-forge/.github/actions/\`.`,
      '',
      '## Conventions',
      '',
      '- All TLM agents use `claude-opus-4-6`.',
      '- Handoff files use v3 format.',
      '',
    ].join('\n');
    await pushFile(
      `${owner}/${repoName}`,
      defaultBranch,
      'CLAUDE.md',
      claudeMd,
      'chore: add starter CLAUDE.md'
    );
    steps.push({ name: 'push-claude-md', status: 'success' });
    progress('push-claude-md', 'done');
  } catch (err) {
    // Non-fatal — continue
    steps.push({
      name: 'push-claude-md',
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    progress('push-claude-md', 'done');
  }

  // Step 4: Set repo secrets
  progress('set-secrets', 'start');
  try {
    await _sodium.ready;
    const sodium = _sodium;

    const publicKeyData = await getRepoPublicKey(owner, repoName);
    const keyBytes = sodium.from_base64(
      publicKeyData.key,
      sodium.base64_variants.ORIGINAL
    );

    const secretValues: Record<string, string> = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
      AGENT_FORGE_API_SECRET: process.env.AGENT_FORGE_API_SECRET ?? '',
      AGENT_FORGE_URL: process.env.AGENT_FORGE_URL ?? '',
    };

    for (const [secretName, secretValue] of Object.entries(secretValues)) {
      if (!secretValue) continue;
      const messageBytes = sodium.from_string(secretValue);
      const encryptedBytes = sodium.crypto_box_seal(messageBytes, keyBytes);
      const encryptedBase64 = sodium.to_base64(
        encryptedBytes,
        sodium.base64_variants.ORIGINAL
      );
      await setRepoSecret(owner, repoName, secretName, encryptedBase64, publicKeyData.key_id);
    }
    steps.push({ name: 'set-secrets', status: 'success' });
    progress('set-secrets', 'done');
  } catch (err) {
    steps.push({
      name: 'set-secrets',
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    skipRemaining('set-secrets', steps);
    progress('set-secrets', 'done');
    return cleanupAndFail({ repoUrl, repoId });
  }

  // Step 5: Register repo in storage
  let registrationId = '';
  progress('register-repo', 'start');
  try {
    const repoConfig = await createRepo({
      fullName: `${owner}/${repoName}`,
      shortName: repoName,
      claudeMdPath: 'CLAUDE.md',
      handoffDir: 'handoffs/awaiting_handoff/',
      executeWorkflow: 'execute-handoff.yml',
      concurrencyLimit: 1,
      defaultBudget: 8,
    });
    registrationId = repoConfig.id;
    steps.push({ name: 'register-repo', status: 'success', detail: repoConfig.id });
    progress('register-repo', 'done');
  } catch (err) {
    steps.push({
      name: 'register-repo',
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    skipRemaining('register-repo', steps);
    progress('register-repo', 'done');
    return cleanupAndFail({ repoUrl, repoId });
  }

  // Step 6: Enable GitHub Actions permissions
  progress('enable-actions', 'start');
  try {
    await setActionsPermissions(owner, repoName);
    await setDefaultWorkflowPermissions(owner, repoName);
    steps.push({ name: 'enable-actions', status: 'success' });
    progress('enable-actions', 'done');
  } catch (err) {
    steps.push({
      name: 'enable-actions',
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    progress('enable-actions', 'done');
    // Non-fatal — continue to branch protection
  }

  // Step 7: Branch protection
  progress('branch-protection', 'start');
  try {
    await setBranchProtection(owner, repoName, defaultBranch);
    steps.push({ name: 'branch-protection', status: 'success' });
    progress('branch-protection', 'done');
  } catch (err) {
    steps.push({
      name: 'branch-protection',
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    progress('branch-protection', 'done');
    // Non-fatal
  }

  // Step 8: Vercel project (optional)
  let vercelProjectUrl: string | undefined;
  if (options.createVercelProject) {
    progress('vercel-project', 'start');
    try {
      vercelProjectUrl = await createVercelProject(repoName, owner, options);
      steps.push({ name: 'vercel-project', status: 'success', detail: vercelProjectUrl });
      progress('vercel-project', 'done');
    } catch (err) {
      steps.push({
        name: 'vercel-project',
        status: 'failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      progress('vercel-project', 'done');
      // Non-fatal — checklist will flag manual setup
    }
  } else {
    steps.push({ name: 'vercel-project', status: 'skipped' });
    progress('vercel-project', 'skip');
  }

  return {
    repoUrl,
    repoId,
    registrationId,
    vercelProjectUrl,
    steps,
    checklist: buildChecklist(options, steps),
  };
}
