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
