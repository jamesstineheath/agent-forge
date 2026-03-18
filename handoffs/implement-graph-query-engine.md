# Agent Forge -- Implement Graph Query Engine

## Metadata
- **Branch:** `feat/implement-graph-query-engine`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/knowledge-graph/query.ts, lib/__tests__/knowledge-graph-query.test.ts

## Context

Agent Forge is a dev orchestration platform (Next.js on Vercel). This task builds the **query engine** for the knowledge graph subsystem at `lib/knowledge-graph/`. The knowledge graph stores code entities (functions, classes, files, etc.) and their relationships (imports, calls, exports, etc.), and is used by the Decomposer and other consumers to reason about the codebase.

A concurrent work item is implementing the TypeScript AST parser (`lib/knowledge-graph/parser.ts`, branch `feat/build-typescript-ast-parser-for-code-entity-extrac`). That work defines the `KnowledgeGraph`, `CodeEntity`, and `Relationship` types that this query engine depends on. You must **not modify** `lib/knowledge-graph/parser.ts` or `lib/__tests__/knowledge-graph-parser.test.ts`.

**Known merged work:** A previous PR titled "feat: implement knowledge graph query engine" already merged files at `lib/knowledge-graph/query.ts` and `lib/__tests__/knowledge-graph-query.test.ts`. Before starting, check whether these files already exist and what they contain — the current work item may be a re-implementation or extension. If they exist but are incomplete against the acceptance criteria, complete them. If they exist and are already complete, note this in the PR body.

**No other files in the codebase should be modified.** This is a pure additive feature: new file + new test file only.

## Requirements

1. `lib/knowledge-graph/query.ts` must export the following functions with the exact signatures below:
   - `queryGraph(graph: KnowledgeGraph, query: GraphQuery): GraphQueryResult`
   - `findRelated(graph: KnowledgeGraph, entityId: string, options: { depth?: number, relationshipTypes?: string[] }): GraphQueryResult`
   - `findDependents(graph: KnowledgeGraph, entityId: string): CodeEntity[]`
   - `findDependencies(graph: KnowledgeGraph, entityId: string): CodeEntity[]`
   - `getFileEntities(graph: KnowledgeGraph, filePath: string): CodeEntity[]`
   - `getCallChain(graph: KnowledgeGraph, entityId: string, direction: 'callers' | 'callees', maxDepth?: number): CodeEntity[][]`

2. `queryGraph` must support filtering by `entityType`, `namePattern` (regex), `filePath` (exact or glob), and `repo` independently and in combination (all active filters ANDed together).

3. `findRelated` traverses the graph BFS up to `depth` hops (default 1), following all relationship types unless `relationshipTypes` is specified, and returns all discovered entities plus their connecting relationships.

4. `findDependents` returns all entities where a relationship exists with `target === entityId` (i.e., entities that point TO the given entity — callers/importers).

5. `findDependencies` returns all entities where a relationship exists with `source === entityId` (i.e., entities that the given entity points TO — callees/imports).

6. `getFileEntities` returns all `CodeEntity` objects whose `filePath` matches the given path exactly.

7. `getCallChain` returns an array of call chains: for `callers`, find all entities that call the given entity (recursively to `maxDepth`, default 5); for `callees`, find all entities called by the given entity recursively. Each chain is an ordered array from root to leaf.

8. All functions must handle invalid/missing inputs gracefully: null/undefined `entityId`, empty graph, missing entity IDs — return empty results, never throw.

9. Unit tests in `lib/__tests__/knowledge-graph-query.test.ts` must use a hand-built test graph with **at least 10 entities** and **at least 15 relationships**, covering all six exported functions.

10. TypeScript must compile with no errors (`npx tsc --noEmit`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/implement-graph-query-engine
```

### Step 1: Inspect existing types and files

Check what already exists to avoid conflicts with concurrent work:

```bash
# Check if query.ts already exists
cat lib/knowledge-graph/query.ts 2>/dev/null || echo "FILE DOES NOT EXIST"

# Check parser.ts for type definitions
cat lib/knowledge-graph/parser.ts 2>/dev/null || echo "FILE DOES NOT EXIST"

# List the knowledge-graph directory
ls -la lib/knowledge-graph/ 2>/dev/null || echo "DIRECTORY DOES NOT EXIST"

# Check for any existing type exports
grep -r "KnowledgeGraph\|CodeEntity\|Relationship" lib/knowledge-graph/ 2>/dev/null | head -40
```

Note the exact type shapes from `parser.ts`. The query engine must import types from `./parser` (or wherever they are defined). Do **not** redefine types that already exist in parser.ts.

### Step 2: Determine type locations and define GraphQuery / GraphQueryResult

Based on what you find in Step 1, identify where `KnowledgeGraph`, `CodeEntity`, and `Relationship` are exported. If `parser.ts` exists and exports them, import from there. If the directory doesn't exist yet, you'll need to define stub types locally (but prefer importing).

The `GraphQuery` and `GraphQueryResult` types should be defined in `query.ts` itself (or a shared types file if one exists). Suggested shapes:

```typescript
export interface GraphQuery {
  entityType?: string;          // exact match on entity type
  namePattern?: string;         // regex pattern matched against entity name
  filePath?: string;            // exact or glob match against entity filePath
  repo?: string;                // exact match on entity repo
  relatedTo?: string;           // entity ID to traverse from
  relationshipType?: string;    // filter relationships by type when using relatedTo
  depth?: number;               // traversal depth for relatedTo (default 1)
}

export interface GraphQueryResult {
  entities: CodeEntity[];
  relationships: Relationship[];
}
```

### Step 3: Implement `lib/knowledge-graph/query.ts`

Create the file with all six exported functions. Key implementation notes:

**`queryGraph`** — filter `graph.entities` (or equivalent entity collection) against all provided query filters. Filters are ANDed. Use `RegExp` for `namePattern`. For glob `filePath`, use a simple `*` → `.*` conversion or import `minimatch` if already a dependency (check `package.json` first). Collect relationships that connect matched entities.

**`findRelated`** — BFS from `entityId` up to `depth` hops. For each hop, find all relationships where `source === currentId || target === currentId` (bidirectional unless `relationshipTypes` filters to specific types). Accumulate discovered entity IDs, avoid cycles with a visited set. Return all discovered entities and traversed relationships.

**`findDependents`** — filter `graph.relationships` where `rel.target === entityId`. For each matching relationship, look up the entity at `rel.source` and return it. Deduplicate by entity ID.

**`findDependencies`** — filter `graph.relationships` where `rel.source === entityId`. For each matching relationship, look up the entity at `rel.target` and return it. Deduplicate by entity ID.

**`getFileEntities`** — filter `graph.entities` (or entity map values) where `entity.filePath === filePath`.

**`getCallChain`** — recursive DFS. For `callees`: start from `entityId`, find all relationships of type `calls` (or equivalent) where `source === entityId`, collect targets as next nodes, recurse up to `maxDepth`. Each complete path from root to terminal node is one chain. For `callers`: reverse direction (`target === entityId`, follow `source`). Guard against cycles. Return `[]` (empty array of chains) if entity not found.

**Graph access pattern** — adapt to the actual `KnowledgeGraph` shape from Step 1. It may use a `Map<string, CodeEntity>`, an array, or an object. Write helper functions:

```typescript
function getEntity(graph: KnowledgeGraph, id: string): CodeEntity | undefined { ... }
function getAllEntities(graph: KnowledgeGraph): CodeEntity[] { ... }
function getAllRelationships(graph: KnowledgeGraph): Relationship[] { ... }
```

**Grace handling pattern**:
```typescript
export function findDependents(graph: KnowledgeGraph, entityId: string): CodeEntity[] {
  if (!graph || !entityId) return [];
  // ... implementation
}
```

### Step 4: Implement `lib/__tests__/knowledge-graph-query.test.ts`

Build a hand-crafted test graph with **≥10 entities** and **≥15 relationships**. Example domain: a small TypeScript module with files, classes, functions, and their import/call relationships.

```typescript
// Example entity shape (adapt to actual CodeEntity type)
const testEntities: CodeEntity[] = [
  { id: 'e1', name: 'UserService', type: 'class', filePath: 'src/services/user.ts', repo: 'main' },
  { id: 'e2', name: 'getUser',     type: 'function', filePath: 'src/services/user.ts', repo: 'main' },
  { id: 'e3', name: 'createUser',  type: 'function', filePath: 'src/services/user.ts', repo: 'main' },
  { id: 'e4', name: 'UserRepo',    type: 'class', filePath: 'src/repos/user-repo.ts', repo: 'main' },
  { id: 'e5', name: 'findById',    type: 'function', filePath: 'src/repos/user-repo.ts', repo: 'main' },
  { id: 'e6', name: 'save',        type: 'function', filePath: 'src/repos/user-repo.ts', repo: 'main' },
  { id: 'e7', name: 'AuthService', type: 'class', filePath: 'src/services/auth.ts', repo: 'main' },
  { id: 'e8', name: 'login',       type: 'function', filePath: 'src/services/auth.ts', repo: 'main' },
  { id: 'e9', name: 'hashPassword',type: 'function', filePath: 'src/utils/crypto.ts', repo: 'main' },
  { id: 'e10',name: 'DbConnection',type: 'class', filePath: 'src/db/connection.ts', repo: 'external' },
];
// ≥15 relationships: imports, calls between the above entities
```

Tests must cover:
- `queryGraph` with each filter type (entityType, namePattern, filePath, repo) individually
- `queryGraph` with combined filters (AND logic)
- `queryGraph` with empty/null inputs
- `findRelated` at depth 1 and depth 2
- `findRelated` with `relationshipTypes` filter
- `findDependents` for an entity with known dependents
- `findDependencies` for an entity with known dependencies
- `getFileEntities` for a file with multiple entities
- `getFileEntities` for a file with no entities
- `getCallChain` for callers and callees
- `getCallChain` with maxDepth limiting
- All functions with invalid/missing inputs (no throws)

### Step 5: Verify TypeScript compilation and tests

```bash
# Check package.json for test runner
cat package.json | grep -E '"test"|"jest"|"vitest"'

# Run TypeScript check
npx tsc --noEmit

# Run tests (adjust command based on test runner found above)
npm test -- --testPathPattern="knowledge-graph-query" 2>/dev/null || \
npx jest lib/__tests__/knowledge-graph-query.test.ts 2>/dev/null || \
npx vitest run lib/__tests__/knowledge-graph-query.test.ts
```

Fix any type errors or test failures before proceeding.

### Step 6: Final build check

```bash
npx tsc --noEmit
npm run build 2>/dev/null || echo "Build step not required for library-only change"
```

### Step 7: Commit, push, open PR

```bash
git add lib/knowledge-graph/query.ts lib/__tests__/knowledge-graph-query.test.ts
git commit -m "feat: implement knowledge graph query engine

- queryGraph: filter by entityType, namePattern (regex), filePath, repo
- findRelated: BFS traversal up to N hops with optional relationship type filter
- findDependents/findDependencies: directed relationship traversal
- getFileEntities: lookup entities by file path
- getCallChain: recursive call chain extraction (callers/callees)
- All functions handle invalid inputs gracefully (no throws)
- Tests: 10+ entities, 15+ relationships, full coverage of all functions"

git push origin feat/implement-graph-query-engine

gh pr create \
  --title "feat: implement knowledge graph query engine" \
  --body "## Summary
Implements the query engine for the knowledge graph subsystem.

### Exported functions
- \`queryGraph\` — multi-filter entity search with AND logic
- \`findRelated\` — BFS traversal up to N hops
- \`findDependents\` — entities that import/call the given entity
- \`findDependencies\` — entities the given entity imports/calls
- \`getFileEntities\` — all entities in a file
- \`getCallChain\` — recursive caller/callee chains

### Files changed
- \`lib/knowledge-graph/query.ts\` (new)
- \`lib/__tests__/knowledge-graph-query.test.ts\` (new)

### Notes
- Types imported from \`lib/knowledge-graph/parser.ts\` (concurrent work item — not modified)
- No modifications to any file outside the two listed above
- All functions handle null/undefined/empty inputs gracefully

Closes: implement-graph-query-engine work item"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
   ```bash
   git add -A
   git commit -m "wip: partial graph query engine implementation"
   git push origin feat/implement-graph-query-engine
   ```
2. Open the PR with partial status:
   ```bash
   gh pr create --title "feat: implement knowledge graph query engine [WIP]" --body "Partial implementation - see ISSUES below"
   ```
3. Escalate if blocked by missing type definitions from concurrent work item:
   ```bash
   curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
     -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
     -H "Content-Type: application/json" \
     -d '{
       "workItemId": "implement-graph-query-engine",
       "reason": "Cannot resolve KnowledgeGraph/CodeEntity/Relationship types — parser.ts from concurrent work item not yet merged or types not exported as expected",
       "confidenceScore": 0.2,
       "contextSnapshot": {
         "step": "Step 1 or Step 3",
         "error": "Type resolution failure — describe exact error here",
         "filesChanged": ["lib/knowledge-graph/query.ts"]
       }
     }'
   ```

4. Output structured report:
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/implement-graph-query-engine
FILES CHANGED: lib/knowledge-graph/query.ts, lib/__tests__/knowledge-graph-query.test.ts
SUMMARY: [what was implemented]
ISSUES: [what failed or is incomplete]
NEXT STEPS: [what remains — e.g., fix type imports once parser.ts is merged, complete getCallChain implementation, add remaining test cases]
```