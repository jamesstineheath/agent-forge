# Agent Forge -- Define Knowledge Graph Core Types and Schema

## Metadata
- **Branch:** `feat/knowledge-graph-core-types`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/knowledge-graph/types.ts

## Context

Agent Forge is a dev orchestration platform (Next.js on Vercel) that coordinates autonomous agent teams across multiple repositories. This task establishes the foundational TypeScript types for a new Knowledge Graph subsystem.

The Knowledge Graph will index code entities (functions, classes, modules, files, types, variables) and their relationships (imports, calls, extends, implements, exports, uses) across target repositories. These types will serve as the contract for all downstream Knowledge Graph features: indexers, query engines, storage adapters, and API surfaces.

This is a pure type-definition task — no runtime logic, no external dependencies, no API routes. The file will live at `lib/knowledge-graph/types.ts`, following the existing pattern in `lib/` (e.g., `lib/types.ts` for shared platform types).

No files overlap with concurrent work (`lib/debate/agents/judge.ts` is entirely separate).

## Requirements

1. Create `lib/knowledge-graph/types.ts` that exports all core types
2. `CodeEntity` must have: `id`, `type` (union), `name`, `filePath`, `repo`, `startLine`, `endLine`, optional `signature`, optional `docstring`, optional `metadata`
3. `CodeEntity.type` union must cover: `'function' | 'class' | 'module' | 'file' | 'type' | 'variable'`
4. `CodeRelationship` must have: `id`, `sourceId`, `targetId`, `type` (union), optional `metadata`
5. `CodeRelationship.type` union must cover: `'imports' | 'calls' | 'extends' | 'implements' | 'exports' | 'uses'`
6. `KnowledgeGraph` must have: `entities` (Map<string, CodeEntity>), `relationships` (CodeRelationship[]), `repoSnapshots` (RepoSnapshot[]), `lastUpdated` (Date)
7. `RepoSnapshot` must have: `repo`, `commitSha`, `indexedAt` (Date), `entityCount`, `relationshipCount`
8. `GraphQuery` must support optional filtering by: `entityType`, `namePattern` (regex string), `filePath`, `repo`, `relatedTo` (entity ID string), `relationshipType`, `depth` (number)
9. `GraphQueryResult` must have: `entities` (CodeEntity[]), `relationships` (CodeRelationship[]), `totalCount` (number)
10. All types must compile under strict TypeScript — no `any`, use `readonly` where appropriate (arrays and Maps that should not be mutated externally)
11. Export named union types `EntityType` and `RelationshipType` so consumers can reference the discriminants without re-declaring them

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/knowledge-graph-core-types
```

### Step 1: Create the directory and types file

Create `lib/knowledge-graph/types.ts` with the following content:

```typescript
/**
 * Knowledge Graph core types and schema.
 *
 * Defines the foundational data model for indexing code entities and their
 * relationships across target repositories. Used by indexers, query engines,
 * storage adapters, and API surfaces.
 */

// ---------------------------------------------------------------------------
// Discriminated union types (exported for consumer use)
// ---------------------------------------------------------------------------

export type EntityType =
  | 'function'
  | 'class'
  | 'module'
  | 'file'
  | 'type'
  | 'variable';

export type RelationshipType =
  | 'imports'
  | 'calls'
  | 'extends'
  | 'implements'
  | 'exports'
  | 'uses';

// ---------------------------------------------------------------------------
// Core graph nodes
// ---------------------------------------------------------------------------

/**
 * A discrete code entity discovered in a repository. Entities are the nodes
 * of the Knowledge Graph.
 */
export interface CodeEntity {
  /** Stable unique identifier: `{repo}:{filePath}:{type}:{name}:{startLine}` */
  readonly id: string;
  /** Structural category of this entity. */
  readonly type: EntityType;
  /** Simple name of the entity (e.g. function name, class name). */
  readonly name: string;
  /** Repo-relative file path (e.g. `lib/orchestrator.ts`). */
  readonly filePath: string;
  /** GitHub repository slug, e.g. `jamesstineheath/agent-forge`. */
  readonly repo: string;
  /** 1-based line number where the entity begins. */
  readonly startLine: number;
  /** 1-based line number where the entity ends. */
  readonly endLine: number;
  /** Function/method signature or type declaration text, if applicable. */
  readonly signature?: string;
  /** Leading JSDoc/TSDoc comment, if present. */
  readonly docstring?: string;
  /** Arbitrary additional metadata (language-specific, linter tags, etc.). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Core graph edges
// ---------------------------------------------------------------------------

/**
 * A directed relationship between two CodeEntities. Relationships are the
 * edges of the Knowledge Graph.
 */
export interface CodeRelationship {
  /** Stable unique identifier: `{sourceId}:{type}:{targetId}` */
  readonly id: string;
  /** ID of the source entity (the one that depends on / references the target). */
  readonly sourceId: string;
  /** ID of the target entity. */
  readonly targetId: string;
  /** Semantic type of this relationship. */
  readonly type: RelationshipType;
  /** Arbitrary additional metadata (e.g. import alias, call site line). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Snapshot and graph container
// ---------------------------------------------------------------------------

/**
 * A point-in-time snapshot of one repository's indexing state.
 */
export interface RepoSnapshot {
  /** GitHub repository slug, e.g. `jamesstineheath/agent-forge`. */
  readonly repo: string;
  /** Full Git commit SHA that was indexed. */
  readonly commitSha: string;
  /** Timestamp when indexing completed for this snapshot. */
  readonly indexedAt: Date;
  /** Total number of CodeEntities indexed for this repo at this commit. */
  readonly entityCount: number;
  /** Total number of CodeRelationships indexed for this repo at this commit. */
  readonly relationshipCount: number;
}

/**
 * The top-level in-memory Knowledge Graph container.
 * Entities are keyed by their `id` for O(1) lookup.
 */
export interface KnowledgeGraph {
  /** All indexed entities, keyed by `CodeEntity.id`. */
  readonly entities: ReadonlyMap<string, CodeEntity>;
  /** All indexed relationships. */
  readonly relationships: readonly CodeRelationship[];
  /** Per-repo indexing snapshots. */
  readonly repoSnapshots: readonly RepoSnapshot[];
  /** Timestamp of the most recent update to this graph. */
  readonly lastUpdated: Date;
}

// ---------------------------------------------------------------------------
// Query API
// ---------------------------------------------------------------------------

/**
 * Parameters for querying the Knowledge Graph. All fields are optional;
 * multiple fields are combined with logical AND.
 */
export interface GraphQuery {
  /** Filter by entity structural type. */
  entityType?: EntityType;
  /**
   * Filter by entity name using a regex pattern string.
   * Example: `"^use"` matches all names starting with "use".
   */
  namePattern?: string;
  /** Filter by repo-relative file path (exact match). */
  filePath?: string;
  /** Filter by repository slug (exact match). */
  repo?: string;
  /**
   * Return entities related to this entity ID.
   * When set, the result set is restricted to entities reachable from the
   * given ID up to `depth` hops.
   */
  relatedTo?: string;
  /** Filter traversal to relationships of this type (used with `relatedTo`). */
  relationshipType?: RelationshipType;
  /**
   * Maximum traversal depth when `relatedTo` is specified.
   * Defaults to 1 (direct neighbours only).
   */
  depth?: number;
}

/**
 * The result of a Knowledge Graph query.
 */
export interface GraphQueryResult {
  /** Matching entities. */
  readonly entities: readonly CodeEntity[];
  /**
   * Relationships between the returned entities (and, when `relatedTo` is
   * used, along the traversal path).
   */
  readonly relationships: readonly CodeRelationship[];
  /** Total number of matching entities before any pagination. */
  readonly totalCount: number;
}

// ---------------------------------------------------------------------------
// Storage schema (Vercel Blob)
// ---------------------------------------------------------------------------

/**
 * Serialisable form of KnowledgeGraph for persistence in Vercel Blob.
 * `Map` is replaced by a plain record and `Date` values become ISO strings
 * so that JSON round-trips are lossless.
 *
 * Blob path: `af-data/knowledge-graph/{repo-slug}/graph.json`
 */
export interface PersistedKnowledgeGraph {
  /** Entities as a plain record (key = CodeEntity.id). */
  readonly entities: Readonly<Record<string, CodeEntity>>;
  readonly relationships: readonly CodeRelationship[];
  readonly repoSnapshots: readonly RepoSnapshot[];
  /** ISO 8601 timestamp string. */
  readonly lastUpdated: string;
  /** Schema version for future migrations. */
  readonly schemaVersion: number;
}
```

### Step 2: Verify the file compiles cleanly

```bash
npx tsc --noEmit
```

If `tsconfig.json` does not already include `lib/knowledge-graph/types.ts` in its scope (it should via the default `"include": ["**/*.ts"]` or similar), confirm the file is picked up. If there is a path-alias or explicit `paths` config that needs updating, add `lib/knowledge-graph/*` accordingly — but for a pure type file this is unlikely to be needed.

### Step 3: Verification

```bash
# TypeScript strict-mode check
npx tsc --noEmit

# Build (ensures Next.js page graph still resolves cleanly)
npm run build

# Tests (no new tests required for pure types, but run to confirm no regressions)
npm test -- --passWithNoTests
```

Expected: zero TypeScript errors, build succeeds, no test regressions.

### Step 4: Commit, push, open PR

```bash
git add lib/knowledge-graph/types.ts
git commit -m "feat: define Knowledge Graph core types and schema

Adds lib/knowledge-graph/types.ts with:
- EntityType and RelationshipType discriminated unions
- CodeEntity and CodeRelationship interfaces (readonly, no any)
- KnowledgeGraph container (ReadonlyMap + readonly arrays)
- RepoSnapshot for per-repo indexing state
- GraphQuery with depth-aware traversal params
- GraphQueryResult
- PersistedKnowledgeGraph for Vercel Blob serialisation

All types pass strict TypeScript with no 'any'."

git push origin feat/knowledge-graph-core-types

gh pr create \
  --title "feat: define Knowledge Graph core types and schema" \
  --body "## Summary

Establishes the foundational TypeScript type contract for the Knowledge Graph subsystem.

### New file
- \`lib/knowledge-graph/types.ts\`

### Types exported
| Type | Purpose |
|------|---------|
| \`EntityType\` | Union of entity structural categories |
| \`RelationshipType\` | Union of relationship semantic types |
| \`CodeEntity\` | Graph node: a discrete code artifact |
| \`CodeRelationship\` | Graph edge: directed link between entities |
| \`KnowledgeGraph\` | In-memory container (ReadonlyMap + readonly arrays) |
| \`RepoSnapshot\` | Point-in-time indexing state per repo |
| \`GraphQuery\` | Query parameters (AND-combined, depth-aware) |
| \`GraphQueryResult\` | Query output with totalCount |
| \`PersistedKnowledgeGraph\` | Vercel Blob serialisation schema (Map → Record, Date → string) |

### Design notes
- No \`any\` types; all external-facing collections are \`readonly\`
- \`PersistedKnowledgeGraph\` mirrors \`KnowledgeGraph\` but is JSON-safe; includes \`schemaVersion\` for future migrations
- Blob path convention: \`af-data/knowledge-graph/{repo-slug}/graph.json\`

### No overlap with concurrent work
Concurrent branch \`fix/implement-judge-agent-synthesizes-debate-into-verd\` touches \`lib/debate/agents/judge.ts\` only — no shared files." \
  --base main
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/knowledge-graph-core-types
FILES CHANGED: lib/knowledge-graph/types.ts
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If a TypeScript compilation error cannot be resolved after 3 attempts, escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "define-knowledge-graph-core-types",
    "reason": "TypeScript strict-mode compilation error in lib/knowledge-graph/types.ts that cannot be resolved autonomously",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "Step 2 / Step 3",
      "error": "<paste tsc error output>",
      "filesChanged": ["lib/knowledge-graph/types.ts"]
    }
  }'
```