# Agent Forge -- Build TypeScript AST Parser for Code Entity Extraction

## Metadata
- **Branch:** `feat/knowledge-graph-ast-parser`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/knowledge-graph/parser.ts, lib/__tests__/knowledge-graph-parser.test.ts

## Context

Agent Forge is a dev orchestration platform built on Next.js. There is an ongoing effort to build a Knowledge Graph subsystem (see recent merged PR: "feat: define Knowledge Graph core types and schema" touching `lib/knowledge-graph/types.ts`). This task implements the core indexing engine: a pure TypeScript AST parser that extracts code entities from source files.

A concurrent work item ("Implement Knowledge Graph storage layer") is working on `lib/knowledge-graph/storage.ts` and `lib/__tests__/knowledge-graph-storage.test.ts`. **Do not touch those files.** This task only creates `lib/knowledge-graph/parser.ts` and `lib/__tests__/knowledge-graph-parser.test.ts`.

The `typescript` package is available as a dependency in this Next.js project (it's used by the TypeScript compiler for type-checking). The parser must be pure — no file I/O, no side effects — accepting file path, file content as a string, and repo name, returning extracted entities and relationships.

The `CodeEntity` and `CodeRelationship` types are defined in `lib/knowledge-graph/types.ts` (merged PR). Before implementing, read that file to ensure the parser returns the correct shape. If the types file doesn't exist or is incomplete, define the necessary types inline in `parser.ts` and export them.

## Requirements

1. `lib/knowledge-graph/parser.ts` exports a `parseFile(filePath: string, content: string, repo: string): ParseResult` function
2. `ParseResult` is exported and has shape `{ entities: CodeEntity[], localRelationships: CodeRelationship[] }`
3. Parser uses the TypeScript compiler API (`typescript` package) to create a `SourceFile` with `ts.createSourceFile` — no file system access
4. Parser walks the AST and extracts nodes of kind: `FunctionDeclaration`, `ClassDeclaration`, `InterfaceDeclaration`, `TypeAliasDeclaration`, `VariableStatement` (only exported ones), `EnumDeclaration`
5. For each extracted entity: `name`, `kind`, `startLine`, `endLine`, `signature` (for functions: serialized parameter types + return type), `docstring` (JSDoc comment if present), `id` (stable: `{repo}:{filePath}:{entityType}:{name}`)
6. Extracts local relationships from the same file: class `extends` → `EXTENDS` relationship, class `implements` → `IMPLEMENTS` relationship
7. Entity IDs are stable and deterministic using the pattern `{repo}:{filePath}:{entityType}:{name}`
8. Unit tests in `lib/__tests__/knowledge-graph-parser.test.ts` cover:
   - Function declaration extraction (name, parameter types, return type, line numbers)
   - Class declaration extraction (name, line numbers, extends/implements relationships)
   - Interface declaration extraction
   - TypeAlias declaration extraction
   - Enum declaration extraction
   - Exported variable extraction
   - Non-exported variable is NOT extracted
   - JSDoc comment extraction
   - Stable ID generation

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/knowledge-graph-ast-parser
```

### Step 1: Read existing types

Check if `lib/knowledge-graph/types.ts` exists and what types are defined:

```bash
cat lib/knowledge-graph/types.ts 2>/dev/null || echo "FILE NOT FOUND"
```

Note the exact shapes of `CodeEntity` and `CodeRelationship`. The parser must conform to those shapes. If `types.ts` is missing or doesn't define these types, define them in `parser.ts` directly and re-export as needed.

### Step 2: Verify TypeScript package availability

```bash
node -e "const ts = require('typescript'); console.log('ts version:', ts.version)"
```

If this fails, check `package.json` for the `typescript` package. It should already be present as a dev dependency for Next.js. Do not add it — it should already exist.

### Step 3: Implement `lib/knowledge-graph/parser.ts`

Create the file with the following implementation. Adjust `CodeEntity`/`CodeRelationship` imports to match what's in `types.ts`:

```typescript
/**
 * TypeScript AST parser for code entity extraction.
 * Pure function — no I/O, no side effects.
 */
import * as ts from 'typescript';

// Import from types.ts if it defines these; otherwise define inline.
// Adjust the import path/shape to match lib/knowledge-graph/types.ts exactly.
// If types are already exported from types.ts, use:
//   import type { CodeEntity, CodeRelationship } from './types';
// and remove the local definitions below.

export type EntityKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'typeAlias'
  | 'variable'
  | 'enum'
  | 'module';

export interface CodeEntity {
  id: string;
  name: string;
  kind: EntityKind;
  filePath: string;
  repo: string;
  startLine: number;
  endLine: number;
  signature?: string;
  docstring?: string;
}

export type RelationshipKind = 'EXTENDS' | 'IMPLEMENTS' | 'CALLS' | 'IMPORTS';

export interface CodeRelationship {
  fromId: string;
  toName: string; // target may be in another file; resolved later
  kind: RelationshipKind;
}

export interface ParseResult {
  entities: CodeEntity[];
  localRelationships: CodeRelationship[];
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function makeId(repo: string, filePath: string, kind: EntityKind, name: string): string {
  return `${repo}:${filePath}:${kind}:${name}`;
}

function getLineNumbers(
  node: ts.Node,
  sourceFile: ts.SourceFile
): { startLine: number; endLine: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    startLine: start.line + 1, // 1-based
    endLine: end.line + 1,
  };
}

function getJsDoc(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  const fullText = sourceFile.getFullText();
  const nodeStart = node.getFullStart();
  const leadingTrivia = fullText.slice(nodeStart, node.getStart(sourceFile));
  const jsDocMatch = leadingTrivia.match(/\/\*\*([\s\S]*?)\*\//);
  if (jsDocMatch) {
    // Normalize: strip leading * on each line
    return jsDocMatch[0]
      .split('\n')
      .map((line) => line.replace(/^\s*\*\s?/, '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/^\/\*\*/, '')
      .replace(/\*\/$/, '')
      .trim();
  }
  return undefined;
}

function typeNodeToString(typeNode: ts.TypeNode | undefined, sourceFile: ts.SourceFile): string {
  if (!typeNode) return 'any';
  return typeNode.getText(sourceFile);
}

function getFunctionSignature(
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction,
  sourceFile: ts.SourceFile
): string {
  const params = node.parameters
    .map((p) => {
      const name = p.name.getText(sourceFile);
      const type = p.type ? typeNodeToString(p.type, sourceFile) : 'any';
      const optional = p.questionToken ? '?' : '';
      return `${name}${optional}: ${type}`;
    })
    .join(', ');
  const returnType = node.type ? typeNodeToString(node.type, sourceFile) : 'void';
  return `(${params}) => ${returnType}`;
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return (
    modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword
    ) ?? false
  );
}

// ------------------------------------------------------------------
// Main parser
// ------------------------------------------------------------------

export function parseFile(filePath: string, content: string, repo: string): ParseResult {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS
  );

  const entities: CodeEntity[] = [];
  const localRelationships: CodeRelationship[] = [];

  function visit(node: ts.Node): void {
    // --- FunctionDeclaration ---
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.getText(sourceFile);
      const { startLine, endLine } = getLineNumbers(node, sourceFile);
      const id = makeId(repo, filePath, 'function', name);
      entities.push({
        id,
        name,
        kind: 'function',
        filePath,
        repo,
        startLine,
        endLine,
        signature: getFunctionSignature(node, sourceFile),
        docstring: getJsDoc(node, sourceFile),
      });
    }

    // --- ClassDeclaration ---
    else if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.getText(sourceFile);
      const { startLine, endLine } = getLineNumbers(node, sourceFile);
      const id = makeId(repo, filePath, 'class', name);
      entities.push({
        id,
        name,
        kind: 'class',
        filePath,
        repo,
        startLine,
        endLine,
        docstring: getJsDoc(node, sourceFile),
      });

      // Relationships: extends and implements
      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          const relationshipKind: RelationshipKind =
            clause.token === ts.SyntaxKind.ExtendsKeyword ? 'EXTENDS' : 'IMPLEMENTS';
          for (const type of clause.types) {
            localRelationships.push({
              fromId: id,
              toName: type.expression.getText(sourceFile),
              kind: relationshipKind,
            });
          }
        }
      }
    }

    // --- InterfaceDeclaration ---
    else if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.getText(sourceFile);
      const { startLine, endLine } = getLineNumbers(node, sourceFile);
      entities.push({
        id: makeId(repo, filePath, 'interface', name),
        name,
        kind: 'interface',
        filePath,
        repo,
        startLine,
        endLine,
        docstring: getJsDoc(node, sourceFile),
      });
    }

    // --- TypeAliasDeclaration ---
    else if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.getText(sourceFile);
      const { startLine, endLine } = getLineNumbers(node, sourceFile);
      entities.push({
        id: makeId(repo, filePath, 'typeAlias', name),
        name,
        kind: 'typeAlias',
        filePath,
        repo,
        startLine,
        endLine,
        docstring: getJsDoc(node, sourceFile),
      });
    }

    // --- EnumDeclaration ---
    else if (ts.isEnumDeclaration(node)) {
      const name = node.name.getText(sourceFile);
      const { startLine, endLine } = getLineNumbers(node, sourceFile);
      entities.push({
        id: makeId(repo, filePath, 'enum', name),
        name,
        kind: 'enum',
        filePath,
        repo,
        startLine,
        endLine,
        docstring: getJsDoc(node, sourceFile),
      });
    }

    // --- VariableStatement (exported only) ---
    else if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const name = decl.name.getText(sourceFile);
          const { startLine, endLine } = getLineNumbers(node, sourceFile);
          entities.push({
            id: makeId(repo, filePath, 'variable', name),
            name,
            kind: 'variable',
            filePath,
            repo,
            startLine,
            endLine,
            docstring: getJsDoc(node, sourceFile),
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return { entities, localRelationships };
}
```

**IMPORTANT:** After creating the file, re-read `lib/knowledge-graph/types.ts`. If `CodeEntity`, `CodeRelationship`, or `ParseResult` are already defined there, **remove the inline definitions from `parser.ts`** and import from `'./types'` instead. Do not create duplicate type definitions. If `types.ts` defines a different shape (e.g., `kind` uses different string values), reconcile `parser.ts` to match exactly.

### Step 4: Implement `lib/__tests__/knowledge-graph-parser.test.ts`

Create the test file:

```typescript
import { parseFile, ParseResult, CodeEntity } from '../knowledge-graph/parser';

// Multi-entity fixture
const FIXTURE = `
/**
 * Adds two numbers together.
 */
export function add(a: number, b: number): number {
  return a + b;
}

export function noDoc(x: string): void {
  console.log(x);
}

/** Represents an animal. */
export class Animal {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}

export class Dog extends Animal implements Serializable {
  bark(): void {}
}

export interface Serializable {
  serialize(): string;
}

export type ID = string | number;

export enum Direction {
  Up = 'UP',
  Down = 'DOWN',
}

export const MAX_RETRIES = 3;

// Not exported — should NOT appear in entities
const internalSecret = 'hidden';
function privateHelper(): void {}
`;

describe('parseFile', () => {
  let result: ParseResult;

  beforeAll(() => {
    result = parseFile('src/example.ts', FIXTURE, 'my-repo');
  });

  it('returns entities and localRelationships arrays', () => {
    expect(result).toHaveProperty('entities');
    expect(result).toHaveProperty('localRelationships');
    expect(Array.isArray(result.entities)).toBe(true);
    expect(Array.isArray(result.localRelationships)).toBe(true);
  });

  describe('FunctionDeclaration', () => {
    let addFn: CodeEntity | undefined;

    beforeAll(() => {
      addFn = result.entities.find((e) => e.name === 'add' && e.kind === 'function');
    });

    it('extracts function declaration', () => {
      expect(addFn).toBeDefined();
    });

    it('has correct kind', () => {
      expect(addFn?.kind).toBe('function');
    });

    it('has correct signature with parameter types and return type', () => {
      expect(addFn?.signature).toContain('number');
      expect(addFn?.signature).toContain('a');
      expect(addFn?.signature).toContain('b');
    });

    it('has correct line numbers (startLine < endLine)', () => {
      expect(addFn?.startLine).toBeGreaterThan(0);
      expect(addFn?.endLine).toBeGreaterThanOrEqual(addFn!.startLine);
    });

    it('extracts JSDoc docstring', () => {
      expect(addFn?.docstring).toBeTruthy();
      expect(addFn?.docstring).toContain('Adds two numbers');
    });

    it('has stable deterministic ID', () => {
      expect(addFn?.id).toBe('my-repo:src/example.ts:function:add');
    });

    it('extracts noDoc function without docstring', () => {
      const fn = result.entities.find((e) => e.name === 'noDoc');
      expect(fn).toBeDefined();
      expect(fn?.docstring).toBeFalsy();
    });
  });

  describe('ClassDeclaration', () => {
    it('extracts Animal class', () => {
      const animal = result.entities.find((e) => e.name === 'Animal' && e.kind === 'class');
      expect(animal).toBeDefined();
      expect(animal?.startLine).toBeGreaterThan(0);
    });

    it('extracts Animal class JSDoc', () => {
      const animal = result.entities.find((e) => e.name === 'Animal' && e.kind === 'class');
      expect(animal?.docstring).toContain('animal');
    });

    it('extracts Dog class with EXTENDS relationship', () => {
      const dog = result.entities.find((e) => e.name === 'Dog' && e.kind === 'class');
      expect(dog).toBeDefined();
      const extendsRel = result.localRelationships.find(
        (r) => r.fromId === dog?.id && r.kind === 'EXTENDS'
      );
      expect(extendsRel).toBeDefined();
      expect(extendsRel?.toName).toBe('Animal');
    });

    it('extracts Dog class with IMPLEMENTS relationship', () => {
      const dog = result.entities.find((e) => e.name === 'Dog' && e.kind === 'class');
      const implementsRel = result.localRelationships.find(
        (r) => r.fromId === dog?.id && r.kind === 'IMPLEMENTS'
      );
      expect(implementsRel).toBeDefined();
      expect(implementsRel?.toName).toBe('Serializable');
    });
  });

  describe('InterfaceDeclaration', () => {
    it('extracts Serializable interface', () => {
      const iface = result.entities.find((e) => e.name === 'Serializable' && e.kind === 'interface');
      expect(iface).toBeDefined();
      expect(iface?.id).toBe('my-repo:src/example.ts:interface:Serializable');
    });
  });

  describe('TypeAliasDeclaration', () => {
    it('extracts ID type alias', () => {
      const typeAlias = result.entities.find((e) => e.name === 'ID' && e.kind === 'typeAlias');
      expect(typeAlias).toBeDefined();
      expect(typeAlias?.startLine).toBeGreaterThan(0);
    });
  });

  describe('EnumDeclaration', () => {
    it('extracts Direction enum', () => {
      const en = result.entities.find((e) => e.name === 'Direction' && e.kind === 'enum');
      expect(en).toBeDefined();
      expect(en?.id).toBe('my-repo:src/example.ts:enum:Direction');
    });
  });

  describe('VariableStatement', () => {
    it('extracts exported variable MAX_RETRIES', () => {
      const v = result.entities.find((e) => e.name === 'MAX_RETRIES' && e.kind === 'variable');
      expect(v).toBeDefined();
    });

    it('does NOT extract non-exported variable internalSecret', () => {
      const v = result.entities.find((e) => e.name === 'internalSecret');
      expect(v).toBeUndefined();
    });

    it('does NOT extract non-exported function privateHelper', () => {
      const v = result.entities.find((e) => e.name === 'privateHelper');
      expect(v).toBeUndefined();
    });
  });

  describe('Stable IDs', () => {
    it('generates deterministic IDs across multiple parse calls', () => {
      const result2 = parseFile('src/example.ts', FIXTURE, 'my-repo');
      const ids1 = result.entities.map((e) => e.id).sort();
      const ids2 = result2.entities.map((e) => e.id).sort();
      expect(ids1).toEqual(ids2);
    });

    it('ID format is repo:filePath:kind:name', () => {
      for (const entity of result.entities) {
        expect(entity.id).toBe(`${entity.repo}:${entity.filePath}:${entity.kind}:${entity.name}`);
      }
    });
  });
});
```

### Step 5: Reconcile with existing types

Re-read `lib/knowledge-graph/types.ts`:

```bash
cat lib/knowledge-graph/types.ts
```

- If `CodeEntity` is defined there with a different `kind` field (e.g., it uses `'FUNCTION'` instead of `'function'`), update `parser.ts` to match
- If `ParseResult` is already defined, remove it from `parser.ts` and import it
- If there are extra required fields on `CodeEntity` (e.g., `metadata`, `embedding`), either make them optional or provide sensible defaults
- Update test imports accordingly if you change what's exported from `parser.ts`

### Step 6: Check test runner configuration

```bash
cat package.json | grep -A5 '"jest"\|"vitest"\|"test"'
cat jest.config.* 2>/dev/null || cat vitest.config.* 2>/dev/null || echo "No test config found"
```

Confirm the test framework (Jest or Vitest) and ensure `lib/__tests__/` is in the test match pattern. If the project uses Vitest, update the test file to import from `vitest` instead of using Jest globals:

```typescript
// For Vitest, add at top:
import { describe, it, expect, beforeAll } from 'vitest';
```

### Step 7: Verification

```bash
# TypeScript type check — must pass with zero errors
npx tsc --noEmit

# Run tests
npm test -- --testPathPattern="knowledge-graph-parser" 2>/dev/null || \
  npx vitest run lib/__tests__/knowledge-graph-parser.test.ts 2>/dev/null || \
  npx jest lib/__tests__/knowledge-graph-parser.test.ts

# Build check
npm run build
```

All tests must pass. Fix any TypeScript errors before proceeding.

**Common issues to watch for:**
- `ts.canHaveModifiers` may not exist in older TypeScript versions — if so, use `(node as any).modifiers` or check with `'modifiers' in node`
- `ts.getModifiers` may not exist — alternative: `ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined` or access `node.modifiers` directly
- If TypeScript version is < 4.8, replace `ts.canHaveModifiers(node) ? ts.getModifiers(node)` with direct property access: `(node as ts.HasModifiers).modifiers`

To check TypeScript version:
```bash
npx tsc --version
```

If < 4.8, use this alternative for `isExported`:
```typescript
function isExported(node: ts.Node): boolean {
  const modifiers = (node as any).modifiers as ts.NodeArray<ts.Modifier> | undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}
```

### Step 8: Commit, push, open PR

```bash
git add lib/knowledge-graph/parser.ts lib/__tests__/knowledge-graph-parser.test.ts
git commit -m "feat: implement TypeScript AST parser for code entity extraction

- parseFile() uses ts.createSourceFile to parse content strings (no I/O)
- Extracts: FunctionDeclaration, ClassDeclaration, InterfaceDeclaration,
  TypeAliasDeclaration, VariableStatement (exported), EnumDeclaration
- Captures name, kind, start/end lines, signature, JSDoc docstring
- Extracts EXTENDS/IMPLEMENTS relationships from class heritage clauses
- Generates stable IDs: {repo}:{filePath}:{kind}:{name}
- Unit tests cover all entity kinds, relationships, ID stability,
  and non-exported entity exclusion"

git push origin feat/knowledge-graph-ast-parser

gh pr create \
  --title "feat: implement TypeScript AST parser for code entity extraction" \
  --body "## Summary

Implements the core indexing engine for the Knowledge Graph subsystem.

### Changes
- \`lib/knowledge-graph/parser.ts\`: Pure TypeScript AST parser using the \`typescript\` compiler API
- \`lib/__tests__/knowledge-graph-parser.test.ts\`: Unit tests covering all entity extraction cases

### What the parser extracts
- **Functions**: name, parameter types, return type signature, JSDoc, line numbers
- **Classes**: name, JSDoc, line numbers + EXTENDS/IMPLEMENTS relationships
- **Interfaces**: name, JSDoc, line numbers
- **Type Aliases**: name, JSDoc, line numbers
- **Enums**: name, JSDoc, line numbers
- **Variables**: exported only, name, line numbers

### Entity ID format
\`{repo}:{filePath}:{kind}:{name}\` — stable and deterministic across runs

### Notes
- No file I/O — accepts content as string, fully pure
- Compatible with the storage layer work item on branch \`fix/implement-knowledge-graph-storage-layer\`
- Does not touch \`lib/knowledge-graph/storage.ts\` or storage tests

Closes: Knowledge Graph AST Parser work item"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
   ```bash
   git add -A
   git commit -m "wip: partial knowledge-graph parser implementation"
   git push origin feat/knowledge-graph-ast-parser
   ```
2. Open the PR with partial status:
   ```bash
   gh pr create --title "feat: implement TypeScript AST parser (partial)" --body "WIP — see ISSUES below"
   ```
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/knowledge-graph-ast-parser
FILES CHANGED: [list of modified files]
SUMMARY: [what was implemented]
ISSUES: [what failed or is incomplete]
NEXT STEPS: [what remains — e.g., "tests failing due to TypeScript version incompatibility in isExported helper"]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve autonomously (e.g., `lib/knowledge-graph/types.ts` defines `CodeEntity` with an incompatible required shape that would require changes to the concurrent storage layer branch, or the `typescript` package is not available and cannot be added):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "build-typescript-ast-parser",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message>",
      "filesChanged": ["lib/knowledge-graph/parser.ts", "lib/__tests__/knowledge-graph-parser.test.ts"]
    }
  }'
```