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
