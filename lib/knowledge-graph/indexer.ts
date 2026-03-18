import { readRepoFile } from '../github';
import { parseFile } from './parser';
import { buildEntityIndex, extractImports, resolveRelationships } from './resolver';
import { loadGraph, saveGraph, saveRepoSnapshot } from './storage';
import type { CodeEntity, CodeRelationship, KnowledgeGraph, RepoSnapshot } from './types';
import type { ImportInfo } from './resolver';

/**
 * Incrementally re-index a set of changed files for a given repo.
 *
 * Loads the existing graph, re-parses only the changed files from the repo's
 * default branch, removes stale entities/relationships for those files, merges
 * the new parse results, resolves relationships, and persists.
 */
export async function incrementalIndex(
  repo: string,
  changedFiles: string[],
): Promise<{ entitiesUpdated: number }> {
  const tsFiles = changedFiles.filter(
    (f) => f.endsWith('.ts') || f.endsWith('.tsx'),
  );
  if (tsFiles.length === 0) {
    return { entitiesUpdated: 0 };
  }

  const existing = await loadGraph(repo);
  const entities = new Map<string, CodeEntity>(existing?.entities ?? []);
  const oldRelationships = [...(existing?.relationships ?? [])];

  // Remove stale entities for changed files
  const changedFileSet = new Set(tsFiles);
  for (const [id, entity] of entities) {
    if (changedFileSet.has(entity.filePath)) {
      entities.delete(id);
    }
  }

  // Parse changed files and extract imports from the repo's default branch
  const newEntities: CodeEntity[] = [];
  const allImports: ImportInfo[] = [];
  for (const filePath of tsFiles) {
    const content = await readRepoFile(repo, filePath);
    if (!content) continue;
    const result = parseFile(filePath, content, repo);
    for (const entity of result.entities) {
      newEntities.push(entity);
      entities.set(entity.id, entity);
    }
    allImports.push(...extractImports(filePath, content));
  }

  // Rebuild entity index with all entities (existing + new)
  const allEntities = [...entities.values()];
  const entityIndex = buildEntityIndex(allEntities);

  // Keep relationships not involving changed files
  const freshRelationships: CodeRelationship[] = oldRelationships.filter(
    (rel) => {
      const source = entities.get(rel.sourceId);
      const target = entities.get(rel.targetId);
      if (!source || !target) return false;
      return !changedFileSet.has(source.filePath) && !changedFileSet.has(target.filePath);
    },
  );

  // Resolve new relationships from imports in changed files
  const newRelationships = resolveRelationships(allImports, entityIndex);
  const allRelationships = [
    ...freshRelationships,
    ...newRelationships.filter(
      (nr) => !freshRelationships.some((fr) => fr.id === nr.id),
    ),
  ];

  const now = new Date();
  const graph: KnowledgeGraph = {
    entities,
    relationships: allRelationships,
    repoSnapshots: existing?.repoSnapshots ?? [],
    lastUpdated: now,
  };
  await saveGraph(repo, graph);

  const snapshot: RepoSnapshot = {
    repo,
    commitSha: 'incremental',
    indexedAt: now,
    entityCount: entities.size,
    relationshipCount: allRelationships.length,
  };
  await saveRepoSnapshot(snapshot);

  return { entitiesUpdated: newEntities.length };
}

/**
 * Full re-index of a repository. Fetches the repo's file tree from GitHub,
 * parses all TypeScript files, and persists the complete graph.
 */
export async function fullIndex(repo: string): Promise<{ entityCount: number }> {
  // Fetch the recursive tree of the default branch
  const token = process.env.GH_PAT;
  const res = await fetch(
    `https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch repo tree for ${repo}: ${res.status}`);
  }
  const tree = (await res.json()) as {
    tree: Array<{ path: string; type: string }>;
  };

  const tsFiles = tree.tree.filter(
    (item) =>
      item.type === 'blob' &&
      (item.path.endsWith('.ts') || item.path.endsWith('.tsx')) &&
      !item.path.includes('node_modules'),
  );

  const allEntities: CodeEntity[] = [];
  const allImports: ImportInfo[] = [];
  for (const file of tsFiles) {
    const content = await readRepoFile(repo, file.path);
    if (!content) continue;
    const result = parseFile(file.path, content, repo);
    allEntities.push(...result.entities);
    allImports.push(...extractImports(file.path, content));
  }

  const entityMap = new Map<string, CodeEntity>();
  for (const entity of allEntities) {
    entityMap.set(entity.id, entity);
  }

  const entityIndex = buildEntityIndex(allEntities);
  const relationships = resolveRelationships(allImports, entityIndex);

  const now = new Date();
  const graph: KnowledgeGraph = {
    entities: entityMap,
    relationships,
    repoSnapshots: [],
    lastUpdated: now,
  };
  await saveGraph(repo, graph);

  const snapshot: RepoSnapshot = {
    repo,
    commitSha: 'full-reindex',
    indexedAt: now,
    entityCount: entityMap.size,
    relationshipCount: relationships.length,
  };
  await saveRepoSnapshot(snapshot);

  return { entityCount: entityMap.size };
}
