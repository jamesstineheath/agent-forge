# Agent Forge -- Define Knowledge Graph Core Types and Schema

## Metadata
- **Branch:** `fix/define-knowledge-graph-core-types-and-schema`
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

### Step 0: Pre-flight checks
