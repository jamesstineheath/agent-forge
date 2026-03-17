import _sodium from 'libsodium-wrappers';
import { BootstrapOptions, BootstrapResult, BootstrapStep } from './types';
import { getTemplateFiles } from './templates';
import {
  createGitHubRepo,
  pushFile,
  getRepoPublicKey,
  setRepoSecret,
  setActionsPermissions,
  setDefaultWorkflowPermissions,
} from './github';
import { createRepo } from './repos';

function skipRemaining(names: string[], steps: BootstrapStep[]) {
  for (const name of names) {
    steps.push({ name, status: 'skipped' });
  }
}

export async function bootstrapRepo(
  repoName: string,
  options: BootstrapOptions
): Promise<BootstrapResult> {
  const steps: BootstrapStep[] = [];

  const owner = process.env.GITHUB_OWNER ?? '';

  // Step 1: Create GitHub repo
  let repoUrl = '';
  let repoId = 0;
  let defaultBranch = 'main';

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
  } catch (err) {
    steps.push({
      name: 'create-repo',
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    skipRemaining(['push-workflows', 'set-secrets', 'register-repo', 'enable-actions'], steps);
    return { repoUrl: '', repoId: 0, registrationId: '', steps };
  }

  // Small delay for GitHub to initialize the repo
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Step 2: Push pipeline workflow files
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
    steps.push({ name: 'push-workflows', status: 'success', detail: `Pushed workflow files` });
  } catch (err) {
    steps.push({
      name: 'push-workflows',
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    skipRemaining(['set-secrets', 'register-repo', 'enable-actions'], steps);
    return { repoUrl, repoId, registrationId: '', steps };
  }

  // Step 3: Set repo secrets
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
  } catch (err) {
    steps.push({
      name: 'set-secrets',
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    skipRemaining(['register-repo', 'enable-actions'], steps);
    return { repoUrl, repoId, registrationId: '', steps };
  }

  // Step 4: Register repo in Blob store
  let registrationId = '';
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
  } catch (err) {
    steps.push({
      name: 'register-repo',
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    skipRemaining(['enable-actions'], steps);
    return { repoUrl, repoId, registrationId: '', steps };
  }

  // Step 5: Enable GitHub Actions permissions
  try {
    await setActionsPermissions(owner, repoName);
    await setDefaultWorkflowPermissions(owner, repoName);
    steps.push({ name: 'enable-actions', status: 'success' });
  } catch (err) {
    steps.push({
      name: 'enable-actions',
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
    });
    return { repoUrl, repoId, registrationId, steps };
  }

  return { repoUrl, repoId, registrationId, steps };
}
