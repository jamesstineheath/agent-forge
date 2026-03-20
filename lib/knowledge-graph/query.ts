/**
 * Knowledge Graph query engine.
 * Pure functions — no I/O, no side effects. Operates only on an in-memory
 * KnowledgeGraph object passed in.
 */
import type {
  KnowledgeGraph,
  CodeEntity,
  CodeRelationship,
  GraphQuery,
  GraphQueryResult,
  RelationshipType,
} from './types';
import type { RepoContext } from '../orchestrator';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function matchesGlob(pattern: string, value: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return pattern === value;
  }
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§DOUBLE§')
    .replace(/\*/g, '[^/]*')
    .replace(/§DOUBLE§/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${regexStr}$`).test(value);
}

function getAllEntities(graph: KnowledgeGraph): CodeEntity[] {
  return Array.from(graph.entities.values());
}

/**
 * BFS traversal from a starting entity, following relationships in both
 * directions up to `depth` hops. Optionally filtered by relationship types.
 */
function bfsTraverse(
  graph: KnowledgeGraph,
  startId: string,
  depth: number,
  relationshipTypes?: RelationshipType[],
): { entities: CodeEntity[]; relationships: CodeRelationship[] } {
  if (!graph.entities.has(startId)) {
    return { entities: [], relationships: [] };
  }

  const visited = new Set<string>([startId]);
  const collectedRelationships: CodeRelationship[] = [];
  let frontier = [startId];

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const nextFrontier: string[] = [];

    for (const currentId of frontier) {
      for (const rel of graph.relationships) {
        if (relationshipTypes && !relationshipTypes.includes(rel.type)) continue;

        let neighborId: string | null = null;
        if (rel.sourceId === currentId) {
          neighborId = rel.targetId;
        } else if (rel.targetId === currentId) {
          neighborId = rel.sourceId;
        }

        if (neighborId !== null && !visited.has(neighborId)) {
          visited.add(neighborId);
          nextFrontier.push(neighborId);
          collectedRelationships.push(rel);
        } else if (neighborId !== null && visited.has(neighborId)) {
          // Still collect the relationship even if already visited
          if (!collectedRelationships.includes(rel)) {
            collectedRelationships.push(rel);
          }
        }
      }
    }

    frontier = nextFrontier;
  }

  // Remove starting entity from results
  visited.delete(startId);

  const entities: CodeEntity[] = [];
  for (const id of visited) {
    const entity = graph.entities.get(id);
    if (entity) entities.push(entity);
  }

  return { entities, relationships: collectedRelationships };
}

// ---------------------------------------------------------------------------
// Exported query functions
// ---------------------------------------------------------------------------

/**
 * Execute a query against the graph with AND semantics for multiple filters.
 */
export function queryGraph(graph: KnowledgeGraph, query: GraphQuery): GraphQueryResult {
  if (!graph || !graph.entities) return { entities: [], relationships: [], totalCount: 0 };
  let entities = getAllEntities(graph);

  // Apply namePattern filter
  if (query.namePattern !== undefined) {
    const regex = new RegExp(query.namePattern);
    entities = entities.filter((e) => regex.test(e.name));
  }

  // Apply filePath filter (exact or glob)
  if (query.filePath !== undefined) {
    entities = entities.filter((e) => matchesGlob(query.filePath!, e.filePath));
  }

  // Apply entityType filter
  if (query.entityType !== undefined) {
    entities = entities.filter((e) => e.type === query.entityType);
  }

  // Apply repo filter
  if (query.repo !== undefined) {
    entities = entities.filter((e) => e.repo === query.repo);
  }

  // Apply relatedTo traversal filter
  if (query.relatedTo !== undefined) {
    const depth = query.depth ?? 1;
    const relTypes = query.relationshipType ? [query.relationshipType] : undefined;
    const traversal = bfsTraverse(graph, query.relatedTo, depth, relTypes);
    const relatedIds = new Set(traversal.entities.map((e) => e.id));
    entities = entities.filter((e) => relatedIds.has(e.id));
  }

  // Collect relationships between matching entities
  const entityIds = new Set(entities.map((e) => e.id));
  const relationships = graph.relationships.filter(
    (r) => entityIds.has(r.sourceId) && entityIds.has(r.targetId),
  );

  return {
    entities,
    relationships,
    totalCount: entities.length,
  };
}

/**
 * Find entities related to entityId via BFS up to depth hops.
 */
export function findRelated(
  graph: KnowledgeGraph,
  entityId: string,
  options?: { depth?: number; relationshipTypes?: RelationshipType[] },
): GraphQueryResult {
  if (!graph || !graph.entities || !entityId) return { entities: [], relationships: [], totalCount: 0 };
  const depth = options?.depth ?? 1;
  const result = bfsTraverse(graph, entityId, depth, options?.relationshipTypes);

  return {
    entities: result.entities,
    relationships: result.relationships,
    totalCount: result.entities.length,
  };
}

/**
 * Find all entities that depend on (point TO) the given entity.
 */
export function findDependents(graph: KnowledgeGraph, entityId: string): CodeEntity[] {
  if (!graph || !graph.relationships || !entityId) return [];
  const dependentIds = new Set<string>();
  for (const rel of graph.relationships) {
    if (rel.targetId === entityId) {
      dependentIds.add(rel.sourceId);
    }
  }

  const result: CodeEntity[] = [];
  for (const id of dependentIds) {
    const entity = graph.entities.get(id);
    if (entity) result.push(entity);
  }
  return result;
}

/**
 * Find all entities that the given entity depends on (points TO).
 */
export function findDependencies(graph: KnowledgeGraph, entityId: string): CodeEntity[] {
  if (!graph || !graph.relationships || !entityId) return [];
  const depIds = new Set<string>();
  for (const rel of graph.relationships) {
    if (rel.sourceId === entityId) {
      depIds.add(rel.targetId);
    }
  }

  const result: CodeEntity[] = [];
  for (const id of depIds) {
    const entity = graph.entities.get(id);
    if (entity) result.push(entity);
  }
  return result;
}

/**
 * Get all entities defined in a given file.
 */
export function getFileEntities(graph: KnowledgeGraph, filePath: string): CodeEntity[] {
  if (!graph || !graph.entities || !filePath) return [];
  return getAllEntities(graph).filter((e) => e.filePath === filePath);
}

/**
 * Get call chains starting from entityId. BFS up to maxDepth, returns array
 * of paths. Each path is an array of CodeEntity (excluding the starting entity).
 *
 * - `'callers'`: follow relationships where targetId === currentId (who calls this)
 * - `'callees'`: follow relationships where sourceId === currentId (what this calls)
 *
 * Only traverses 'calls' relationship type. Avoids cycles.
 */
export function getCallChain(
  graph: KnowledgeGraph,
  entityId: string,
  direction: 'callers' | 'callees',
  maxDepth = 5,
): CodeEntity[][] {
  if (!graph || !graph.entities || !entityId || !graph.entities.has(entityId)) return [];

  const callRels = graph.relationships.filter((r) => r.type === 'calls');
  const paths: string[][] = [];

  // BFS: each queue entry is [currentEntityId, path so far (entity IDs)]
  const queue: Array<[string, string[]]> = [[entityId, []]];

  while (queue.length > 0) {
    const [currentId, currentPath] = queue.shift()!;

    if (currentPath.length >= maxDepth) continue;

    const neighbors: string[] = [];
    for (const rel of callRels) {
      if (direction === 'callers' && rel.targetId === currentId) {
        neighbors.push(rel.sourceId);
      } else if (direction === 'callees' && rel.sourceId === currentId) {
        neighbors.push(rel.targetId);
      }
    }

    for (const neighborId of neighbors) {
      // Cycle detection: skip if already in path or is the start
      if (neighborId === entityId || currentPath.includes(neighborId)) continue;

      const newPath = [...currentPath, neighborId];
      paths.push(newPath);

      if (newPath.length < maxDepth) {
        queue.push([neighborId, newPath]);
      }
    }
  }

  // Resolve IDs to entities
  return paths.map((p) =>
    p
      .map((id) => graph.entities.get(id))
      .filter((e): e is CodeEntity => e !== undefined),
  );
}

// ---------------------------------------------------------------------------
// Blast radius analysis
// ---------------------------------------------------------------------------

/**
 * Return all entities in the given file paths.
 */
export function getEntitiesByFiles(
  graph: KnowledgeGraph,
  filePaths: string[],
): CodeEntity[] {
  const pathSet = new Set(filePaths);
  const results: CodeEntity[] = [];
  for (const entity of graph.entities.values()) {
    if (pathSet.has(entity.filePath)) {
      results.push(entity);
    }
  }
  return results;
}

/**
 * Given files being modified, find all files that import from them (direct
 * importers), and transitively their importers up to `depth` hops.
 * Also identifies test files in the affected set.
 */
export function getBlastRadius(
  graph: KnowledgeGraph,
  filePaths: string[],
  depth: number = 2,
): {
  affectedFiles: string[];
  affectedEntities: CodeEntity[];
  relationships: CodeRelationship[];
  testFiles: string[];
} {
  // Build reverse-import adjacency: targetEntityId -> sourceEntityId[]
  const reverseImports = new Map<string, Set<string>>();
  for (const rel of graph.relationships) {
    if (rel.type === 'imports') {
      if (!reverseImports.has(rel.targetId)) {
        reverseImports.set(rel.targetId, new Set());
      }
      reverseImports.get(rel.targetId)!.add(rel.sourceId);
    }
  }

  // Seed: entities in the given files
  const seedEntities = getEntitiesByFiles(graph, filePaths);
  const visited = new Set<string>(seedEntities.map((e) => e.id));
  let frontier = new Set<string>(visited);

  // BFS up to `depth` hops through reverse imports
  for (let d = 0; d < depth && frontier.size > 0; d++) {
    const nextFrontier = new Set<string>();
    for (const entityId of frontier) {
      const importers = reverseImports.get(entityId);
      if (!importers) continue;
      for (const importerId of importers) {
        if (!visited.has(importerId)) {
          visited.add(importerId);
          nextFrontier.add(importerId);
        }
      }
    }
    frontier = nextFrontier;
  }

  // Collect affected entities and files
  const affectedEntities: CodeEntity[] = [];
  const affectedFileSet = new Set<string>();
  for (const id of visited) {
    const entity = graph.entities.get(id);
    if (entity) {
      affectedEntities.push(entity);
      affectedFileSet.add(entity.filePath);
    }
  }

  // Relationships between affected entities
  const relationships = graph.relationships.filter(
    (r) => visited.has(r.sourceId) && visited.has(r.targetId),
  );

  // Identify test files
  const testFiles = [...affectedFileSet].filter(
    (f) =>
      f.includes('.test.') ||
      f.includes('.spec.') ||
      f.includes('__tests__/') ||
      f.includes('test/'),
  );

  return {
    affectedFiles: [...affectedFileSet],
    affectedEntities,
    relationships,
    testFiles,
  };
}

// ---------------------------------------------------------------------------
// Context filtering helpers
// ---------------------------------------------------------------------------

/**
 * Given the raw SYSTEM_MAP.md content and file paths, return only the
 * sections of the system map that are relevant to those files.
 */
export function getRelevantSystemMapSections(
  systemMapContent: string,
  filePaths: string[],
): string {
  if (!systemMapContent || filePaths.length === 0) return '';

  // Extract directory prefixes from file paths
  const dirPrefixes = new Set<string>();
  for (const fp of filePaths) {
    const parts = fp.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirPrefixes.add(parts.slice(0, i).join('/'));
    }
    dirPrefixes.add(fp);
  }

  const lines = systemMapContent.split('\n');
  const relevantLines: string[] = [];
  let inRelevantSection = false;
  let currentSectionLevel = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const heading = headingMatch[2];

      const isRelevant = [...dirPrefixes].some(
        (prefix) =>
          heading.includes(prefix) ||
          heading.toLowerCase().includes(prefix.split('/').pop()?.toLowerCase() ?? ''),
      );

      if (isRelevant) {
        inRelevantSection = true;
        currentSectionLevel = level;
        relevantLines.push(line);
      } else if (inRelevantSection && level <= currentSectionLevel) {
        inRelevantSection = false;
      } else if (inRelevantSection) {
        relevantLines.push(line);
      }
    } else if (inRelevantSection) {
      relevantLines.push(line);
    } else {
      const lineRelevant = [...dirPrefixes].some((prefix) => line.includes(prefix));
      if (lineRelevant) {
        relevantLines.push(line);
      }
    }
  }

  return relevantLines.join('\n').trim();
}

/**
 * Return ADRs whose content mentions the affected directories or entity names.
 */
export function getRelevantADRs(
  adrs: Array<{ title: string; status: string; decision: string }>,
  filePaths: string[],
  entityNames: string[],
): Array<{ title: string; status: string; decision: string }> {
  if (adrs.length === 0) return [];

  const searchTerms = new Set<string>();
  for (const fp of filePaths) {
    const parts = fp.split('/');
    for (const part of parts) {
      if (part && !part.includes('.')) searchTerms.add(part.toLowerCase());
    }
    const basename = parts[parts.length - 1];
    if (basename) {
      searchTerms.add(basename.replace(/\.\w+$/, '').toLowerCase());
    }
  }
  for (const name of entityNames) {
    searchTerms.add(name.toLowerCase());
  }

  return adrs.filter((adr) => {
    const text = `${adr.title} ${adr.decision}`.toLowerCase();
    return [...searchTerms].some((term) => text.includes(term));
  });
}

// ---------------------------------------------------------------------------
// Targeted context builder (main integration point for decomposer)
// ---------------------------------------------------------------------------

/**
 * Build targeted context for the decomposer by querying the knowledge graph.
 * Replaces the full-context dump with graph-targeted context.
 */
export function buildTargetedContext(
  graph: KnowledgeGraph,
  repoContext: RepoContext,
  fileHints: { filesToCreate: string[]; filesToModify: string[] },
): string {
  const allFiles = [...fileHints.filesToCreate, ...fileHints.filesToModify];

  // Get blast radius for files being modified
  const blastRadius = getBlastRadius(graph, fileHints.filesToModify, 2);

  // Get relevant system map sections
  const allAffectedFiles = [...new Set([...allFiles, ...blastRadius.affectedFiles])];
  const systemMapSections = repoContext.systemMap
    ? getRelevantSystemMapSections(repoContext.systemMap, allAffectedFiles)
    : '';

  // Get entity names from blast radius for ADR matching
  const entityNames = blastRadius.affectedEntities.map((e) => e.name);
  const relevantADRs = getRelevantADRs(repoContext.adrs, allAffectedFiles, entityNames);

  const sections: string[] = [];

  sections.push(`### CLAUDE.md\n${repoContext.claudeMd || '(not available)'}`);

  if (systemMapSections) {
    sections.push(`### System Map (relevant sections)\n${systemMapSections}`);
  } else if (repoContext.systemMap) {
    sections.push('### System Map\n(no sections matched affected files)');
  }

  if (relevantADRs.length > 0) {
    sections.push(
      `### Relevant ADRs\n${relevantADRs
        .map((adr) => `- **${adr.title}** (${adr.status}): ${adr.decision}`)
        .join('\n')}`,
    );
  }

  if (blastRadius.affectedFiles.length > 0) {
    const sourceFiles = blastRadius.affectedFiles.filter(
      (f) => !f.includes('.test.') && !f.includes('.spec.'),
    );
    sections.push(
      `### Blast Radius\n` +
        `Affected source files (${sourceFiles.length}): ${sourceFiles.slice(0, 20).join(', ')}` +
        (sourceFiles.length > 20 ? ` (+${sourceFiles.length - 20} more)` : '') +
        (blastRadius.testFiles.length > 0
          ? `\nAffected test files (${blastRadius.testFiles.length}): ${blastRadius.testFiles.slice(0, 10).join(', ')}`
          : ''),
    );
  }

  return sections.join('\n\n');
}

/**
 * Get a single entity by ID, plus its direct relationships and related entities.
 */
export function getEntityWithRelationships(
  graph: KnowledgeGraph,
  entityId: string,
): { entity: CodeEntity | null; relationships: CodeRelationship[]; relatedEntities: CodeEntity[] } {
  const entity = graph.entities.get(entityId) ?? null;
  if (!entity) return { entity: null, relationships: [], relatedEntities: [] };

  const relationships = graph.relationships.filter(
    (r) => r.sourceId === entityId || r.targetId === entityId,
  );

  const relatedIds = new Set<string>();
  for (const r of relationships) {
    if (r.sourceId !== entityId) relatedIds.add(r.sourceId);
    if (r.targetId !== entityId) relatedIds.add(r.targetId);
  }

  const relatedEntities: CodeEntity[] = [];
  for (const id of relatedIds) {
    const e = graph.entities.get(id);
    if (e) relatedEntities.push(e);
  }

  return { entity, relationships, relatedEntities };
}
