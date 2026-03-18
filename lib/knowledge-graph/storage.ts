import {
  KnowledgeGraph,
  CodeEntity,
  CodeRelationship,
  PersistedKnowledgeGraph,
  RepoSnapshot,
} from './types';
import { loadJson, saveJson, deleteJson } from '../storage';

/**
 * Storage key for a repo's knowledge graph.
 * The storage layer auto-prefixes with `af-data/` and appends `.json`.
 */
function graphKey(repo: string): string {
  return `knowledge-graph/${repo}/graph`;
}

function snapshotKey(repo: string): string {
  return `knowledge-graph/${repo}/snapshot`;
}

const SCHEMA_VERSION = 1;

export async function saveGraph(repo: string, graph: KnowledgeGraph): Promise<void> {
  const persisted: PersistedKnowledgeGraph = {
    entities: Object.fromEntries(graph.entities),
    relationships: graph.relationships,
    repoSnapshots: graph.repoSnapshots,
    lastUpdated: graph.lastUpdated.toISOString(),
    schemaVersion: SCHEMA_VERSION,
  };
  await saveJson(graphKey(repo), persisted);
}

export async function loadGraph(repo: string): Promise<KnowledgeGraph | null> {
  const persisted = await loadJson<PersistedKnowledgeGraph>(graphKey(repo));
  if (!persisted) return null;

  return {
    entities: new Map<string, CodeEntity>(
      Object.entries(persisted.entities),
    ),
    relationships: persisted.relationships as readonly CodeRelationship[],
    repoSnapshots: persisted.repoSnapshots as readonly RepoSnapshot[],
    lastUpdated: new Date(persisted.lastUpdated),
  };
}

export async function saveRepoSnapshot(snapshot: RepoSnapshot): Promise<void> {
  await saveJson(snapshotKey(snapshot.repo), snapshot);
}

export async function loadRepoSnapshot(repo: string): Promise<RepoSnapshot | null> {
  return loadJson<RepoSnapshot>(snapshotKey(repo));
}

export async function deleteGraph(repo: string): Promise<void> {
  await Promise.all([
    deleteJson(graphKey(repo)),
    deleteJson(snapshotKey(repo)),
  ]);
}
