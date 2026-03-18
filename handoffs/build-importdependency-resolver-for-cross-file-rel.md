# Agent Forge -- Build import/dependency resolver for cross-file relationships

## Metadata
- **Branch:** `feat/build-import-dependency-resolver-for-cross-file-rel`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/knowledge-graph/resolver.ts, lib/__tests__/knowledge-graph-resolver.test.ts

## Context

This task implements a cross-file import/dependency resolver for the Agent Forge knowledge graph subsystem. The knowledge graph (see `lib/knowledge-graph/`) is being built to map code entities and their relationships across the codebase.

Relevant existing work already merged:
- `lib/knowledge-graph/types.ts` — Defines `CodeEntity`, `CodeRelationship`, and related types
- `lib/knowledge-graph/storage.ts` — Storage layer for the knowledge graph

Concurrent work (do NOT touch these files):
- `lib/knowledge-graph/parser.ts` — TypeScript AST parser (branch: `feat/build-typescript-ast-parser-for-code-entity-extrac`)
- `lib/__tests__/knowledge-graph-parser.test.ts`

This resolver sits between the parser (which extracts entities from individual files) and the storage layer. It takes entities extracted from multiple files, analyzes their import statements, and creates `CodeRelationship` objects that link entities across file boundaries.

The resolver operates on **source text** (for `extractImports`) and on **already-parsed entity arrays** (for `resolveRelationships`). It does NOT need to invoke the TypeScript compiler or AST — it uses regex-based parsing of import/export statements, which is sufficient for the cross-file linking use case.

## Requirements

1. `lib/knowledge-graph/resolver.ts` must export three functions: `extractImports`, `resolveRelationships`, and `buildEntityIndex`.
2. `ImportInfo` interface must include: `source: string`, `specifiers: { name: string, alias?: string, isDefault: boolean }[]`, `isTypeOnly: boolean`, `filePath: string`.
3. `extractImports(filePath, content)` must handle:
   - Named imports: `import { foo, bar as baz } from './module'`
   - Default imports: `import Foo from './module'`
   - Namespace imports: `import * as ns from './module'`
   - Re-exports: `export { foo } from './module'` and `export * from './module'`
   - Type-only imports: `import type { Foo } from './module'`
   - Combined (default + named): `import Foo, { bar } from './module'`
4. `buildEntityIndex(allEntities)` returns a `Map<string, CodeEntity[]>` keyed by normalized file path.
5. `resolveRelationships(imports, entityIndex)` creates `CodeRelationship` objects with:
   - `type: 'imports'`
   - `fromId` pointing to the importing file's primary entity (or a synthetic file-level entity id)
   - `toId` pointing to the matched exported entity
   - `metadata.isTypeOnly: boolean`
   - `metadata.specifier: string` (the import specifier name)
6. Bare specifiers (no leading `./` or `../`) are detected as npm packages and skipped (not resolved).
7. Unit tests in `lib/__tests__/knowledge-graph-resolver.test.ts` cover at least 3 interconnected files and verify named, default, namespace, re-export, and type-only import resolution.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/build-import-dependency-resolver-for-cross-file-rel
```

### Step 1: Inspect existing types

Read the existing types file to understand `CodeEntity` and `CodeRelationship` shapes before writing any code:

```bash
cat lib/knowledge-graph/types.ts
```

Note the exact field names for `CodeEntity` (especially `id`, `filePath`, `name`, `kind`) and `CodeRelationship` (especially `id`, `type`, `fromId`, `toId`, `metadata`). The implementation must conform exactly to these types.

If `lib/knowledge-graph/types.ts` doesn't exist yet (concurrent work still in progress), define the minimal interfaces locally in `resolver.ts` with a comment `// Mirrors types.ts — update when merged` and make the exported functions generic enough to accept the real types once available. However, prefer importing from `types.ts` if the file exists.

### Step 2: Implement `lib/knowledge-graph/resolver.ts`

Create the file. The implementation should:

```typescript
// lib/knowledge-graph/resolver.ts

import path from 'path';
import { CodeEntity, CodeRelationship } from './types'; // adjust if types differ

export interface ImportSpecifier {
  name: string;       // exported name in source module (or '*' for namespace)
  alias?: string;     // local name if different (import { foo as bar } → alias='bar')
  isDefault: boolean; // true for `import Foo from '...'`
}

export interface ImportInfo {
  source: string;                  // raw specifier: './foo', '../bar', 'lodash'
  specifiers: ImportSpecifier[];
  isTypeOnly: boolean;             // import type { ... }
  filePath: string;                // absolute or repo-relative path of the importing file
}
```

**`extractImports` implementation notes:**
- Use regex patterns (not AST) — sufficient for well-formed TypeScript
- Handle multi-line imports by collapsing whitespace before matching
- Patterns to cover:
  - `import type? { ... } from '...'` — named, optionally type-only
  - `import type? DefaultName from '...'` — default
  - `import * as ns from '...'` — namespace → specifier `{ name: '*', alias: 'ns', isDefault: false }`
  - `import type? DefaultName, { ... } from '...'` — combined
  - `export { ... } from '...'` — re-export named
  - `export * from '...'` — re-export all → specifier `{ name: '*', isDefault: false }`
  - `export * as ns from '...'` — re-export namespace
- Skip `import()` dynamic imports and `require()` calls
- Return empty array on parse errors (don't throw)

**`buildEntityIndex` implementation notes:**
- Key: normalized `filePath` from each entity (use `path.normalize`)
- Value: array of all `CodeEntity` objects from that file
- Handle the case where `filePath` may be absolute or relative — normalize consistently

**`resolveRelationships` implementation notes:**
- For each `ImportInfo`:
  1. Skip if `source` is a bare specifier (no `./` or `../` prefix)
  2. Resolve `source` relative to `importInfo.filePath` using `path.resolve(path.dirname(importInfo.filePath), source)`
  3. Try common extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `/index.ts`, `/index.tsx`
  4. Look up resolved path in `entityIndex`
  5. For each specifier, find matching entity in target file:
     - Named import: match `entity.name === specifier.name`
     - Default import: match `entity.kind === 'default'` or first entity if no default
     - Namespace: create one relationship pointing to the file itself (use the first entity or synthesize)
  6. Create a `CodeRelationship` for each matched specifier
- Generate `id` as `${fromFilePath}:${specifier.name}→${toEntityId}` or similar stable string
- Set `metadata: { isTypeOnly: importInfo.isTypeOnly, specifier: specifier.name }`
- If no matching entity found in target file, still create the relationship but set `toId` to `${resolvedPath}:unknown`

### Step 3: Implement `lib/__tests__/knowledge-graph-resolver.test.ts`

Write comprehensive tests. The test suite must simulate 3+ interconnected files:

**Test scenario — three-file graph:**
```
fileA.ts  exports: function `parseConfig` (default), class `Config` (named)
fileB.ts  imports: default from fileA, named `Config` from fileA; exports: type `Options`
fileC.ts  imports: `Options` type from fileB, namespace import from fileA, re-exports from fileB
```

**Test cases to include:**
1. `extractImports` — named import with alias
2. `extractImports` — default import
3. `extractImports` — namespace import
4. `extractImports` — type-only import (verify `isTypeOnly: true`)
5. `extractImports` — re-export statement (`export { foo } from './bar'`)
6. `extractImports` — bare specifier (e.g., `import React from 'react'`) returns entry with `source: 'react'`
7. `buildEntityIndex` — entities indexed by file path, multiple entities per file
8. `resolveRelationships` — named import creates relationship with correct `fromId`/`toId`
9. `resolveRelationships` — type-only import sets `metadata.isTypeOnly: true`
10. `resolveRelationships` — bare specifier import is skipped (no relationship created)
11. `resolveRelationships` — namespace import creates relationship
12. Integration: build index from 3 files, extract imports from all 3, resolve all relationships, verify graph connectivity

**Test runner:** use Jest (check `package.json` for the test script — likely `npm test` or `npx jest`).

Mock `CodeEntity` objects inline in the test file (don't import from parser or storage).

### Step 4: Verify TypeScript and tests

```bash
# Type check
npx tsc --noEmit

# Run only the new test file to avoid flaky unrelated tests
npx jest lib/__tests__/knowledge-graph-resolver.test.ts --no-coverage

# If the above fails, run all tests to confirm scope of issues
npm test
```

Fix any type errors before proceeding. Do not suppress errors with `@ts-ignore` unless there is a genuine type incompatibility with `types.ts` that cannot be resolved without modifying shared types (in which case, add a comment explaining why).

### Step 5: Commit, push, open PR

```bash
git add lib/knowledge-graph/resolver.ts lib/__tests__/knowledge-graph-resolver.test.ts
git commit -m "feat: implement import/dependency resolver for cross-file relationships

- extractImports: regex-based parser for named, default, namespace, re-export, and type-only imports
- buildEntityIndex: Map<filePath, CodeEntity[]> for O(1) file lookup
- resolveRelationships: matches import specifiers to known entities, creates 'imports' CodeRelationship objects
- Skips bare specifiers (npm packages), handles relative path resolution
- Unit tests cover 3-file interconnected graph with 12 test cases"

git push origin feat/build-import-dependency-resolver-for-cross-file-rel

gh pr create \
  --title "feat: build import/dependency resolver for cross-file relationships" \
  --body "## Summary
Implements the cross-file import resolver for the knowledge graph subsystem.

## Changes
- \`lib/knowledge-graph/resolver.ts\` — New file with three exports:
  - \`extractImports(filePath, content)\`: regex-based import statement parser
  - \`buildEntityIndex(allEntities)\`: indexes CodeEntity[] by file path
  - \`resolveRelationships(imports, entityIndex)\`: creates \`imports\` CodeRelationship objects
- \`lib/__tests__/knowledge-graph-resolver.test.ts\` — Unit tests with 3-file interconnected graph scenario

## Design Notes
- Regex-based (not AST) import parsing — sufficient for well-formed TS, avoids coupling to parser work
- Bare specifiers (npm packages) are detected and skipped
- Type-only imports propagate \`isTypeOnly: true\` to relationship metadata
- Namespace imports create a single relationship to the target file's first entity

## Testing
\`\`\`
npx jest lib/__tests__/knowledge-graph-resolver.test.ts
\`\`\`

## Concurrent Work
Does not touch \`lib/knowledge-graph/parser.ts\` or \`lib/__tests__/knowledge-graph-parser.test.ts\` (branch: feat/build-typescript-ast-parser-for-code-entity-extrac)."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
```bash
git add -A
git commit -m "wip: partial import resolver implementation"
git push origin feat/build-import-dependency-resolver-for-cross-file-rel
```
2. Open a draft PR:
```bash
gh pr create --draft --title "feat: build import/dependency resolver [WIP]" --body "Partial implementation — see ISSUES below."
```
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/build-import-dependency-resolver-for-cross-file-rel
FILES CHANGED: [lib/knowledge-graph/resolver.ts, lib/__tests__/knowledge-graph-resolver.test.ts]
SUMMARY: [what was implemented]
ISSUES: [what failed or blocked — e.g., "CodeEntity type shape in types.ts differs from assumptions: missing 'kind' field"]
NEXT STEPS: [e.g., "Align ImportInfo specifier matching with actual CodeEntity.kind values once types.ts is finalized"]
```

## Escalation Protocol

If blocked on an unresolvable issue (e.g., `lib/knowledge-graph/types.ts` doesn't exist and concurrent work has not landed, making it impossible to type-check the resolver):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "build-import-dependency-resolver-for-cross-file-rel",
    "reason": "lib/knowledge-graph/types.ts does not exist and concurrent parser branch has not merged — cannot resolve CodeEntity/CodeRelationship type shapes",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "1",
      "error": "Cannot find module ./types or its corresponding type declarations",
      "filesChanged": ["lib/knowledge-graph/resolver.ts"]
    }
  }'
```