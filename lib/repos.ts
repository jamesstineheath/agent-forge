import { randomUUID } from "crypto";
import { loadJson, saveJson, deleteJson } from "./storage";
import type {
  RepoConfig,
  RepoIndexEntry,
  CreateRepoInput,
  UpdateRepoInput,
} from "./types";

const INDEX_KEY = "repos/index";

function repoKey(id: string): string {
  return `repos/${id}`;
}

async function loadIndex(): Promise<RepoIndexEntry[]> {
  return (await loadJson<RepoIndexEntry[]>(INDEX_KEY)) ?? [];
}

async function saveIndex(index: RepoIndexEntry[]): Promise<void> {
  await saveJson(INDEX_KEY, index);
}

export async function listRepos(): Promise<RepoIndexEntry[]> {
  return loadIndex();
}

export async function getRepo(id: string): Promise<RepoConfig | null> {
  return loadJson<RepoConfig>(repoKey(id));
}

export async function createRepo(data: CreateRepoInput): Promise<RepoConfig> {
  const now = new Date().toISOString();
  const repo: RepoConfig = {
    id: randomUUID(),
    fullName: data.fullName,
    shortName: data.shortName,
    claudeMdPath: data.claudeMdPath,
    systemMapPath: data.systemMapPath,
    adrPath: data.adrPath,
    handoffDir: data.handoffDir,
    executeWorkflow: data.executeWorkflow,
    concurrencyLimit: data.concurrencyLimit,
    defaultBudget: data.defaultBudget,
    createdAt: now,
    updatedAt: now,
  };

  await saveJson(repoKey(repo.id), repo);

  const index = await loadIndex();
  index.push({
    id: repo.id,
    fullName: repo.fullName,
    shortName: repo.shortName,
    updatedAt: repo.updatedAt,
  });
  await saveIndex(index);

  return repo;
}

export async function updateRepo(
  id: string,
  patch: UpdateRepoInput
): Promise<RepoConfig | null> {
  const existing = await getRepo(id);
  if (!existing) return null;

  const updated: RepoConfig = {
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  await saveJson(repoKey(id), updated);

  const index = await loadIndex();
  const idx = index.findIndex((e) => e.id === id);
  if (idx !== -1) {
    index[idx] = {
      id: updated.id,
      fullName: updated.fullName,
      shortName: updated.shortName,
      updatedAt: updated.updatedAt,
    };
    await saveIndex(index);
  }

  return updated;
}

export async function deleteRepo(id: string): Promise<boolean> {
  const existing = await getRepo(id);
  if (!existing) return false;

  await deleteJson(repoKey(id));

  const index = await loadIndex();
  const filtered = index.filter((e) => e.id !== id);
  await saveIndex(filtered);

  return true;
}
