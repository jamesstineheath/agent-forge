# Agent Forge -- Implement Graph Query Engine

## Metadata
- **Branch:** `feat/knowledge-graph-query-engine`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/knowledge-graph/query.ts, lib/__tests__/knowledge-graph-query.test.ts

## Context

Agent Forge's knowledge graph system is being built out incrementally. The following layers already exist:

- `lib/knowledge-graph/types.ts` — Core types: `KnowledgeGraph`, `CodeEntity`, `Relationship`, `EntityType`, etc.
- `lib/knowledge-graph/storage.ts` — CRUD layer for persisting/loading the graph
- `lib/knowledge-graph/parser.ts` — TypeScript AST parser that extracts `CodeEntity` objects from source files
- `lib/knowledge-graph/resolver.ts` — Import/dependency resolver that links entities across files

This task adds the **query engine** (`lib/knowledge-graph/query.ts`), which is the primary interface for the Decomposer and other consumers to ask questions about the codebase. It must be pure (no I/O), operating only on an in-memory `KnowledgeGraph` object passed in.

Before starting, read the existing type definitions carefully:

```bash
cat lib/knowledge-graph/types.ts
cat lib/knowledge-graph/storage.ts
cat lib/knowledge-graph/resolver.ts
```

Pay attention to:
- The shape of `KnowledgeGraph` (likely has `entities: Map<string, CodeEntity>` or similar, and `relationships: Relationship[]` or a map)
- The shape of `Relationship` (likely has `sourceId`, `targetId`, `type` fields)
- Any existing `GraphQuery` or `GraphQueryResult` types (use them if they exist; define them if they don't)

## Requirements

1. `lib/knowledge-graph/query.ts` must export the following functions with the exact signatures below (adapting types to match what's in `types.ts`):
   - `queryGraph(graph: KnowledgeGraph, query: GraphQuery): GraphQueryResult`
   - `findRelated(graph: KnowledgeGraph, entityId: string, options?: { depth?: number; relationshipTypes?: string[] }): GraphQueryResult`
   - `findDependents(graph: KnowledgeGraph, entityId: string): CodeEntity[]`
   - `findDependencies(graph: KnowledgeGraph, entityId: string): CodeEntity[]`
   - `getFileEntities(graph: KnowledgeGraph, filePath: string): CodeEntity[]`
   - `getCallChain(graph: KnowledgeGraph, entityId: string, direction: 'callers' | 'callees', maxDepth?: number): CodeEntity[][]`

2. `GraphQuery` type (define in `query.ts` or `types.ts` if not already defined) must support:
   - `namePattern?: RegExp | string` — regex match against entity name
   - `filePath?: string` — exact or glob match against entity file path
   - `entityType?: EntityType` — exact match on entity type
   - `repo?: string` — exact match on entity repo
   - `relatedTo?: string` — entity ID to traverse from
   - `relationshipType?: string` — filter traversal by relationship type
   - `depth?: number` — max traversal depth (default: 1)

3. `GraphQueryResult` type must include:
   - `entities: CodeEntity[]`
   - `relationships: Relationship[]`

4. `queryGraph` must support all filter fields independently and in combination (AND semantics when multiple filters provided).

5. `findRelated` must do a BFS/DFS up to `depth` hops, returning all discovered entities and the relationships connecting them.

6. `findDependents` follows relationships where `targetId === entityId` (things that point TO this entity).

7. `findDependencies` follows relationships where `sourceId === entityId` (things this entity points TO).

8. `getCallChain` returns an array of paths (each path is an array of `CodeEntity`), starting from the given entity. `'callers'` = entities that call this entity; `'callees'` = entities this entity calls. Respects `maxDepth` (default: 5). Use BFS and avoid cycles.

9. All functions must handle invalid/missing inputs gracefully: unknown `entityId` → return empty result, never throw.

10. Unit tests in `lib/__tests__/knowledge-graph-query.test.ts` must:
    - Build a hand-crafted test graph with ≥10 entities and ≥15 relationships
    - Test all 6 exported functions
    - Test combination filters in `queryGraph`
    - Test depth limiting in `findRelated` and `getCallChain`
    - Test graceful handling of unknown entity IDs

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/knowledge-graph-query-engine
```

### Step 1: Read existing types and understand graph shape

```bash
cat lib/knowledge-graph/types.ts
cat lib/knowledge-graph/storage.ts
cat lib/knowledge-graph/resolver.ts
cat lib/knowledge-graph/parser.ts
# Also check any existing tests for usage patterns
ls lib/__tests__/
cat lib/__tests__/knowledge-graph-storage.test.ts 2>/dev/null || true
cat lib/__tests__/knowledge-graph-resolver.test.ts 2>/dev/null || true
cat lib/__tests__/knowledge-graph-parser.test.ts 2>/dev/null || true
```

Note the exact field names on `KnowledgeGraph`, `CodeEntity`, and `Relationship`. Your implementation must use these exact field names.

### Step 2: Implement `lib/knowledge-graph/query.ts`

Create the file. Structure it as follows (adapt field names to match actual types from Step 1):

```typescript
import type { KnowledgeGraph, CodeEntity, Relationship, EntityType } from './types';
import { minimatch } from 'minimatch'; // use if available; otherwise implement simple glob manually

export interface GraphQuery {
  namePattern?: RegExp | string;
  filePath?: string;
  entityType?: EntityType;
  repo?: string;
  relatedTo?: string;
  relationshipType?: string;
  depth?: number;
}

export interface GraphQueryResult {
  entities: CodeEntity[];
  relationships: Relationship[];
}

/** Execute a query against the graph with AND semantics for multiple filters */
export function queryGraph(graph: KnowledgeGraph, query: GraphQuery): GraphQueryResult {
  // 1. Get all entities as starting set
  // 2. Apply namePattern filter (convert string to RegExp if needed)
  // 3. Apply filePath filter (exact match first, fall back to glob if contains * or ?)
  // 4. Apply entityType filter
  // 5. Apply repo filter
  // 6. Apply relatedTo + depth + relationshipType filter (traverse, intersect with entity set)
  // 7. Collect relationships between matching entities
  // Return { entities, relationships }
}

/** Find entities related to entityId via BFS up to depth hops */
export function findRelated(
  graph: KnowledgeGraph,
  entityId: string,
  options?: { depth?: number; relationshipTypes?: string[] }
): GraphQueryResult {
  // BFS from entityId
  // At each hop, follow both directions of relationships unless relationshipTypes filter is set
  // Collect discovered entities (excluding starting entity) and relationships traversed
  // Return empty result if entityId not found
}

/** Find all entities that depend on (import/use) the given entity — things that point TO it */
export function findDependents(graph: KnowledgeGraph, entityId: string): CodeEntity[] {
  // Filter relationships where targetId === entityId
  // Resolve sourceId to CodeEntity
  // Return unique entities
}

/** Find all entities that the given entity depends on — things it points TO */
export function findDependencies(graph: KnowledgeGraph, entityId: string): CodeEntity[] {
  // Filter relationships where sourceId === entityId
  // Resolve targetId to CodeEntity
  // Return unique entities
}

/** Get all entities defined in a given file */
export function getFileEntities(graph: KnowledgeGraph, filePath: string): CodeEntity[] {
  // Filter entities where entity.filePath === filePath
}

/** Get call chains starting from entityId, BFS up to maxDepth, returns array of paths */
export function getCallChain(
  graph: KnowledgeGraph,
  entityId: string,
  direction: 'callers' | 'callees',
  maxDepth = 5
): CodeEntity[][] {
  // BFS: each queue entry is current path (array of entity IDs)
  // callers: follow relationships where targetId === currentId (who calls this)
  // callees: follow relationships where sourceId === currentId (what this calls)
  // Only traverse CALLS/INVOKES relationship types (check what's defined in types.ts)
  // Avoid cycles (track visited per path or globally)
  // Each completed path is one entry in the result array
  // Return [] if entityId not found
}
```

**Important implementation notes:**
- Check if `minimatch` is already in `package.json` before importing it. If not, implement a simple glob check: replace `*` with `.*` and `**` with `.*` and use as regex.
- For accessing entities from the graph, check whether `KnowledgeGraph` stores them as a `Map`, a plain object keyed by ID, or an array. Use the appropriate accessor.
- For call chain relationship types, look at the `RelationshipType` enum/union in `types.ts` — use the "calls" / "invokes" variant.

### Step 3: Implement `lib/__tests__/knowledge-graph-query.test.ts`

Build a rich test graph inline. Example structure to aim for:

```
Files:
  src/a.ts  → defines: FuncA, ClassA
  src/b.ts  → defines: FuncB, FuncC
  src/c.ts  → defines: FuncD, FuncE, InterfaceI
  src/d.ts  → defines: FuncF
  src/e.ts  → defines: ClassB, FuncG, FuncH

Relationships (≥15):
  FuncA → imports → ClassA (IMPORTS)
  FuncB → imports → FuncA (IMPORTS)
  FuncC → imports → FuncA (IMPORTS)
  FuncD → imports → FuncB (IMPORTS)
  FuncD → calls   → FuncB (CALLS)
  FuncE → calls   → FuncC (CALLS)
  FuncF → imports → FuncD (IMPORTS)
  FuncF → calls   → FuncD (CALLS)
  ClassB → implements → InterfaceI (IMPLEMENTS)
  FuncG → calls   → FuncF (CALLS)
  FuncH → calls   → FuncG (CALLS)
  ClassA → implements → InterfaceI (IMPLEMENTS)
  FuncB → calls   → FuncC (CALLS)
  FuncC → calls   → FuncD (CALLS)
  FuncA → calls   → FuncE (CALLS)
```

Test cases to cover:
1. `queryGraph` — filter by `entityType`
2. `queryGraph` — filter by `namePattern` (regex)
3. `queryGraph` — filter by `filePath` (exact)
4. `queryGraph` — filter by `filePath` (glob with `*`)
5. `queryGraph` — combined filter (`entityType` + `filePath`)
6. `queryGraph` — unknown entity in `relatedTo` returns empty
7. `queryGraph` — empty query returns all entities
8. `findRelated` — depth=1 returns only direct neighbors
9. `findRelated` — depth=2 returns second-hop entities
10. `findRelated` — unknown entityId returns empty
11. `findDependents` — returns entities that point TO the given entity
12. `findDependencies` — returns entities the given entity points TO
13. `getFileEntities` — returns all entities in a file
14. `getFileEntities` — unknown file returns empty array
15. `getCallChain` — callees direction
16. `getCallChain` — callers direction
17. `getCallChain` — maxDepth limiting
18. `getCallChain` — cycle detection (no infinite loop)

### Step 4: Check for minimatch availability

```bash
cat package.json | grep minimatch
```

If not present, implement glob matching without it:

```typescript
function matchesGlob(pattern: string, value: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return pattern === value;
  }
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars except * and ?
    .replace(/\*\*/g, '§DOUBLE§')
    .replace(/\*/g, '[^/]*')
    .replace(/§DOUBLE§/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${regexStr}$`).test(value);
}
```

### Step 5: Verification

```bash
# Type check
npx tsc --noEmit

# Run just the new tests
npx jest lib/__tests__/knowledge-graph-query.test.ts --no-coverage

# Run full test suite to ensure no regressions
npm test
```

If TypeScript errors arise from type mismatches with `types.ts`, fix the query.ts types to align — do not modify `types.ts` unless a type that must exist (like `GraphQuery`) is clearly missing and there's no reasonable alternative location for it.

### Step 6: Commit, push, open PR

```bash
git add lib/knowledge-graph/query.ts lib/__tests__/knowledge-graph-query.test.ts
git commit -m "feat: implement knowledge graph query engine

- queryGraph with namePattern/filePath/entityType/repo/relatedTo filters
- findRelated BFS traversal with configurable depth and relationship type filtering
- findDependents and findDependencies for relationship direction traversal
- getFileEntities for file-scoped entity lookup
- getCallChain BFS with cycle detection for caller/callee chains
- Unit tests with 10+ entities and 15+ relationships, all acceptance criteria covered"

git push origin feat/knowledge-graph-query-engine

gh pr create \
  --title "feat: implement knowledge graph query engine" \
  --body "## Summary
Adds \`lib/knowledge-graph/query.ts\` — the primary query interface for the knowledge graph system.

## Functions implemented
- \`queryGraph\` — multi-filter query with AND semantics (entityType, namePattern regex, filePath glob, repo, relatedTo traversal)
- \`findRelated\` — BFS traversal up to configurable depth with optional relationship type filter
- \`findDependents\` — entities that point TO a given entity (reverse direction)
- \`findDependencies\` — entities a given entity points TO (forward direction)
- \`getFileEntities\` — all entities in a given file
- \`getCallChain\` — BFS call chain paths with cycle detection, callers or callees direction

## Tests
\`lib/__tests__/knowledge-graph-query.test.ts\` — hand-built test graph with 10+ entities and 15+ relationships, 18 test cases covering all functions, combination filters, depth limits, and graceful invalid-input handling.

## Notes
- All functions are pure (no I/O)
- Invalid/missing inputs return empty results, never throw
- Glob matching implemented without external deps if minimatch not available"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/knowledge-graph-query-engine
FILES CHANGED: [list whatever was created/modified]
SUMMARY: [what was implemented]
ISSUES: [what failed or is incomplete]
NEXT STEPS: [e.g., "tests not written", "getCallChain missing", "type mismatch on Relationship.type field"]
```

If blocked by an unresolvable ambiguity (e.g., `KnowledgeGraph` shape is radically different from expected, or `types.ts` is missing required types and there's no clear pattern to follow), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "implement-graph-query-engine",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step>",
      "error": "<error or ambiguity description>",
      "filesChanged": ["lib/knowledge-graph/query.ts", "lib/__tests__/knowledge-graph-query.test.ts"]
    }
  }'
```