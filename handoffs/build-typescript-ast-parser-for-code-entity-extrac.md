# Agent Forge -- Build TypeScript AST Parser for Code Entity Extraction

## Metadata
- **Branch:** `feat/typescript-ast-parser-code-entity-extraction`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/knowledge-graph/parser.ts, lib/__tests__/knowledge-graph-parser.test.ts

## Context

Agent Forge needs a knowledge graph system to index code entities across target repositories. This task implements the core parsing engine: a pure TypeScript function that uses the TypeScript compiler API to extract entities (functions, classes, interfaces, types, enums, variables) from source files, along with local relationships (extends, implements, calls).

This is the foundational indexing layer — other knowledge graph components (query engine, indexer) depend on it. The parser must be pure (no I/O) for testability.

A recent merged PR (`feat: implement TypeScript AST parser for code entity extraction`) suggests this work may have been attempted before. Check if `lib/knowledge-graph/parser.ts` already exists before implementing — if it does, review it against the requirements and patch any gaps rather than rewriting from scratch.

The `typescript` package is available as a dependency in the Next.js project. No new dependencies are needed.

## Requirements

1. `lib/knowledge-graph/parser.ts` must export a `parseFile(filePath: string, content: string, repo: string): ParseResult` function
2. `ParseResult` type: `{ entities: CodeEntity[], localRelationships: CodeRelationship[] }`
3. `CodeEntity` must include: `id`, `name`, `kind`, `filePath`, `repo`, `startLine`, `endLine`, `signature` (optional, for functions/methods), `docstring` (optional), `exported` (boolean)
4. `CodeRelationship` must include: `fromId`, `toId`, `type` (e.g. `'extends'`, `'implements'`, `'calls'`)
5. Parser walks AST for: `FunctionDeclaration`, `ClassDeclaration`, `InterfaceDeclaration`, `TypeAliasDeclaration`, `VariableStatement` (exported only), `EnumDeclaration`
6. Entity IDs use format: `{repo}:{filePath}:{entityType}:{name}`
7. For functions: extract parameter types + return type as `signature` string
8. For classes: extract `extends` and `implements` as local relationships
9. JSDoc comments attached to nodes are extracted as `docstring`
10. Unit tests in `lib/__tests__/knowledge-graph-parser.test.ts` cover: function extraction (name, params, return type, lines), class extraction (extends + implements relationships), interface extraction, type alias extraction, enum extraction, exported variable extraction, JSDoc extraction, entity ID format

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/typescript-ast-parser-code-entity-extraction
```

### Step 1: Check for existing files

```bash
ls lib/knowledge-graph/ 2>/dev/null || echo "directory does not exist"
cat lib/knowledge-graph/parser.ts 2>/dev/null || echo "parser.ts does not exist"
cat lib/__tests__/knowledge-graph-parser.test.ts 2>/dev/null || echo "test file does not exist"
```

If both files exist and look complete, skip to Step 4 (run tests). If partially implemented, patch the gaps. If absent, proceed with Step 2.

### Step 2: Create the parser

Create `lib/knowledge-graph/parser.ts`:

```typescript
import * as ts from 'typescript';

export type EntityKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'typeAlias'
  | 'variable'
  | 'enum'
  | 'method';

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
  exported: boolean;
}

export interface CodeRelationship {
  fromId: string;
  toId: string | null; // null when target is external (not in this file)
  type: 'extends' | 'implements' | 'calls';
  targetName?: string; // human-readable name when toId is null
}

export interface ParseResult {
  entities: CodeEntity[];
  localRelationships: CodeRelationship[];
}

function makeEntityId(repo: string, filePath: string, kind: EntityKind, name: string): string {
  return `${repo}:${filePath}:${kind}:${name}`;
}

function getLineNumber(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1; // 1-indexed
}

function extractJSDoc(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  const jsDocComments = (node as ts.JSDocContainer).jsDoc;
  if (!jsDocComments || jsDocComments.length === 0) return undefined;
  const last = jsDocComments[jsDocComments.length - 1];
  return last.getText(sourceFile).replace(/^\/\*\*|\*\/$/g, '').replace(/^\s*\* ?/gm, '').trim();
}

function isExported(node: ts.Declaration): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function extractFunctionSignature(
  node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression,
  checker?: ts.TypeChecker
): string {
  const params = node.parameters.map(p => {
    const name = p.name.getText();
    const typeStr = p.type ? p.type.getText() : 'any';
    const optional = p.questionToken ? '?' : '';
    return `${name}${optional}: ${typeStr}`;
  });
  const returnType = node.type ? node.type.getText() : 'void';
  return `(${params.join(', ')}) => ${returnType}`;
}

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

  // Build a name -> id map for local entities to resolve relationships
  const localEntityIds = new Map<string, string>();

  function registerEntity(entity: CodeEntity) {
    entities.push(entity);
    localEntityIds.set(entity.name, entity.id);
  }

  function visit(node: ts.Node) {
    // FunctionDeclaration
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.getText();
      const kind: EntityKind = 'function';
      const id = makeEntityId(repo, filePath, kind, name);
      registerEntity({
        id,
        name,
        kind,
        filePath,
        repo,
        startLine: getLineNumber(sourceFile, node.getStart()),
        endLine: getLineNumber(sourceFile, node.getEnd()),
        signature: extractFunctionSignature(node),
        docstring: extractJSDoc(node, sourceFile),
        exported: isExported(node),
      });
    }

    // ClassDeclaration
    else if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.getText();
      const kind: EntityKind = 'class';
      const id = makeEntityId(repo, filePath, kind, name);
      registerEntity({
        id,
        name,
        kind,
        filePath,
        repo,
        startLine: getLineNumber(sourceFile, node.getStart()),
        endLine: getLineNumber(sourceFile, node.getEnd()),
        docstring: extractJSDoc(node, sourceFile),
        exported: isExported(node),
      });

      // Extract extends / implements relationships
      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          const relType = clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
          for (const typeExpr of clause.types) {
            const targetName = typeExpr.expression.getText();
            localRelationships.push({
              fromId: id,
              toId: null, // resolved later after all entities are collected
              type: relType,
              targetName,
            });
          }
        }
      }

      // Extract methods
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name) {
          const methodName = member.name.getText();
          const methodKind: EntityKind = 'method';
          const methodId = makeEntityId(repo, filePath, methodKind, `${name}.${methodName}`);
          registerEntity({
            id: methodId,
            name: `${name}.${methodName}`,
            kind: methodKind,
            filePath,
            repo,
            startLine: getLineNumber(sourceFile, member.getStart()),
            endLine: getLineNumber(sourceFile, member.getEnd()),
            signature: extractFunctionSignature(member),
            docstring: extractJSDoc(member, sourceFile),
            exported: isExported(node), // method inherits class export status
          });
        }
      }
    }

    // InterfaceDeclaration
    else if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.getText();
      const kind: EntityKind = 'interface';
      const id = makeEntityId(repo, filePath, kind, name);
      registerEntity({
        id,
        name,
        kind,
        filePath,
        repo,
        startLine: getLineNumber(sourceFile, node.getStart()),
        endLine: getLineNumber(sourceFile, node.getEnd()),
        docstring: extractJSDoc(node, sourceFile),
        exported: isExported(node),
      });

      // Interface extends
      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          for (const typeExpr of clause.types) {
            const targetName = typeExpr.expression.getText();
            localRelationships.push({
              fromId: id,
              toId: null,
              type: 'extends',
              targetName,
            });
          }
        }
      }
    }

    // TypeAliasDeclaration
    else if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.getText();
      const kind: EntityKind = 'typeAlias';
      const id = makeEntityId(repo, filePath, kind, name);
      registerEntity({
        id,
        name,
        kind,
        filePath,
        repo,
        startLine: getLineNumber(sourceFile, node.getStart()),
        endLine: getLineNumber(sourceFile, node.getEnd()),
        docstring: extractJSDoc(node, sourceFile),
        exported: isExported(node),
      });
    }

    // EnumDeclaration
    else if (ts.isEnumDeclaration(node)) {
      const name = node.name.getText();
      const kind: EntityKind = 'enum';
      const id = makeEntityId(repo, filePath, kind, name);
      registerEntity({
        id,
        name,
        kind,
        filePath,
        repo,
        startLine: getLineNumber(sourceFile, node.getStart()),
        endLine: getLineNumber(sourceFile, node.getEnd()),
        docstring: extractJSDoc(node, sourceFile),
        exported: isExported(node),
      });
    }

    // VariableStatement (exported only)
    else if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const name = decl.name.getText();
          const kind: EntityKind = 'variable';
          const id = makeEntityId(repo, filePath, kind, name);

          // Check if the initializer is an arrow function
          let signature: string | undefined;
          if (
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
          ) {
            signature = extractFunctionSignature(decl.initializer);
          }

          registerEntity({
            id,
            name,
            kind,
            filePath,
            repo,
            startLine: getLineNumber(sourceFile, node.getStart()),
            endLine: getLineNumber(sourceFile, node.getEnd()),
            signature,
            docstring: extractJSDoc(node, sourceFile),
            exported: true,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Resolve local relationship toIds now that all entities are registered
  for (const rel of localRelationships) {
    if (rel.toId === null && rel.targetName) {
      const resolved = localEntityIds.get(rel.targetName);
      if (resolved) {
        rel.toId = resolved;
      }
    }
  }

  return { entities, localRelationships };
}
```

### Step 3: Create the test file

Create `lib/__tests__/knowledge-graph-parser.test.ts`:

```typescript
import { parseFile, CodeEntity, CodeRelationship } from '../knowledge-graph/parser';

const REPO = 'test-repo';
const FILE_PATH = 'src/example.ts';

const MULTI_ENTITY_SOURCE = `
/**
 * Adds two numbers together.
 */
export function add(a: number, b: number): number {
  return a + b;
}

/** A base shape interface */
export interface Shape {
  area(): number;
}

/** A circle extending Shape */
export interface Circle extends Shape {
  radius: number;
}

/** A type alias for a coordinate */
export type Point = { x: number; y: number };

/** Direction enum */
export enum Direction {
  Up,
  Down,
  Left,
  Right,
}

/** A rectangle class */
export class Rectangle implements Shape {
  constructor(public width: number, public height: number) {}

  area(): number {
    return this.width * this.height;
  }
}

export class Square extends Rectangle {
  constructor(size: number) {
    super(size, size);
  }
}

export const PI = 3.14159;

export const multiply = (x: number, y: number): number => x * y;

// Non-exported — should NOT appear
function internalHelper(): void {}
const internalVar = 42;
`;

describe('parseFile', () => {
  let result: ReturnType<typeof parseFile>;

  beforeAll(() => {
    result = parseFile(FILE_PATH, MULTI_ENTITY_SOURCE, REPO);
  });

  // ── Entity ID format ──────────────────────────────────────────────────────

  it('generates entity IDs in {repo}:{filePath}:{kind}:{name} format', () => {
    const fn = result.entities.find(e => e.name === 'add');
    expect(fn).toBeDefined();
    expect(fn!.id).toBe(`${REPO}:${FILE_PATH}:function:add`);
  });

  // ── Function extraction ───────────────────────────────────────────────────

  it('extracts function declaration with correct name and kind', () => {
    const fn = result.entities.find(e => e.name === 'add');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.exported).toBe(true);
  });

  it('extracts function parameter types and return type as signature', () => {
    const fn = result.entities.find(e => e.name === 'add');
    expect(fn!.signature).toContain('number');
    expect(fn!.signature).toContain('a');
    expect(fn!.signature).toContain('b');
  });

  it('extracts function start and end line numbers', () => {
    const fn = result.entities.find(e => e.name === 'add');
    expect(fn!.startLine).toBeGreaterThan(0);
    expect(fn!.endLine).toBeGreaterThanOrEqual(fn!.startLine);
  });

  it('extracts JSDoc comment for function', () => {
    const fn = result.entities.find(e => e.name === 'add');
    expect(fn!.docstring).toContain('Adds two numbers');
  });

  it('does not extract non-exported functions', () => {
    const fn = result.entities.find(e => e.name === 'internalHelper');
    expect(fn).toBeUndefined();
  });

  // ── Interface extraction ──────────────────────────────────────────────────

  it('extracts interface declaration', () => {
    const iface = result.entities.find(e => e.name === 'Shape' && e.kind === 'interface');
    expect(iface).toBeDefined();
    expect(iface!.exported).toBe(true);
  });

  it('extracts interface with correct line numbers', () => {
    const iface = result.entities.find(e => e.name === 'Shape');
    expect(iface!.startLine).toBeGreaterThan(0);
    expect(iface!.endLine).toBeGreaterThan(iface!.startLine);
  });

  it('extracts interface extends relationship', () => {
    const circleId = `${REPO}:${FILE_PATH}:interface:Circle`;
    const rel = result.localRelationships.find(
      r => r.fromId === circleId && r.type === 'extends'
    );
    expect(rel).toBeDefined();
    expect(rel!.targetName).toBe('Shape');
  });

  // ── Type alias extraction ─────────────────────────────────────────────────

  it('extracts type alias declaration', () => {
    const typeAlias = result.entities.find(e => e.name === 'Point' && e.kind === 'typeAlias');
    expect(typeAlias).toBeDefined();
    expect(typeAlias!.exported).toBe(true);
  });

  it('extracts type alias line numbers', () => {
    const typeAlias = result.entities.find(e => e.name === 'Point');
    expect(typeAlias!.startLine).toBeGreaterThan(0);
  });

  // ── Enum extraction ───────────────────────────────────────────────────────

  it('extracts enum declaration', () => {
    const en = result.entities.find(e => e.name === 'Direction' && e.kind === 'enum');
    expect(en).toBeDefined();
    expect(en!.exported).toBe(true);
  });

  it('extracts enum JSDoc', () => {
    const en = result.entities.find(e => e.name === 'Direction');
    expect(en!.docstring).toContain('Direction enum');
  });

  // ── Class extraction ──────────────────────────────────────────────────────

  it('extracts class declaration', () => {
    const cls = result.entities.find(e => e.name === 'Rectangle' && e.kind === 'class');
    expect(cls).toBeDefined();
    expect(cls!.exported).toBe(true);
  });

  it('extracts class implements relationship', () => {
    const rectangleId = `${REPO}:${FILE_PATH}:class:Rectangle`;
    const rel = result.localRelationships.find(
      r => r.fromId === rectangleId && r.type === 'implements'
    );
    expect(rel).toBeDefined();
    expect(rel!.targetName).toBe('Shape');
  });

  it('extracts class extends relationship', () => {
    const squareId = `${REPO}:${FILE_PATH}:class:Square`;
    const rel = result.localRelationships.find(
      r => r.fromId === squareId && r.type === 'extends'
    );
    expect(rel).toBeDefined();
    expect(rel!.targetName).toBe('Rectangle');
  });

  it('resolves toId for extends relationship when target is in same file', () => {
    const squareId = `${REPO}:${FILE_PATH}:class:Square`;
    const rectangleId = `${REPO}:${FILE_PATH}:class:Rectangle`;
    const rel = result.localRelationships.find(
      r => r.fromId === squareId && r.type === 'extends'
    );
    expect(rel!.toId).toBe(rectangleId);
  });

  it('extracts class JSDoc', () => {
    const cls = result.entities.find(e => e.name === 'Rectangle');
    expect(cls!.docstring).toContain('rectangle');
  });

  // ── Exported variable extraction ──────────────────────────────────────────

  it('extracts exported const variable', () => {
    const v = result.entities.find(e => e.name === 'PI' && e.kind === 'variable');
    expect(v).toBeDefined();
    expect(v!.exported).toBe(true);
  });

  it('does not extract non-exported variables', () => {
    const v = result.entities.find(e => e.name === 'internalVar');
    expect(v).toBeUndefined();
  });

  it('extracts signature for arrow function variable', () => {
    const v = result.entities.find(e => e.name === 'multiply' && e.kind === 'variable');
    expect(v).toBeDefined();
    expect(v!.signature).toBeDefined();
    expect(v!.signature).toContain('number');
  });

  // ── ParseResult shape ─────────────────────────────────────────────────────

  it('returns both entities and localRelationships arrays', () => {
    expect(Array.isArray(result.entities)).toBe(true);
    expect(Array.isArray(result.localRelationships)).toBe(true);
  });

  it('extracts multiple entities from a multi-entity file', () => {
    expect(result.entities.length).toBeGreaterThanOrEqual(4); // at minimum: add, Shape, Point, Direction
  });
});
```

### Step 4: Ensure directory exists

```bash
mkdir -p lib/knowledge-graph
mkdir -p lib/__tests__
```

### Step 5: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- `ts.canHaveModifiers` may not exist in older TS versions — fallback: cast to `any` and access `.modifiers` directly
- `ts.JSDocContainer` may need casting: `(node as any).jsDoc`

If `ts.canHaveModifiers` is unavailable, replace the `isExported` function with:

```typescript
function isExported(node: ts.Node): boolean {
  const modifiers = (node as any).modifiers as ts.ModifierLike[] | undefined;
  return modifiers?.some((m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}
```

### Step 6: Run tests

```bash
npm test -- --testPathPattern="knowledge-graph-parser" --no-coverage
```

All tests must pass. If any fail, debug the specific extraction logic. Common issues:
- Line numbers off by 1: check `getStart()` vs `pos` usage (`getStart()` skips leading trivia/JSDoc)
- JSDoc not found: `(node as any).jsDoc` may be undefined if `setParentNodes` is false (it's set to `true` in the implementation above)
- `getText()` fails: requires `sourceFile` to be passed or the node was created without parent refs

### Step 7: Full build check

```bash
npm run build
```

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: implement TypeScript AST parser for code entity extraction"
git push origin feat/typescript-ast-parser-code-entity-extraction
gh pr create \
  --title "feat: implement TypeScript AST parser for code entity extraction" \
  --body "## Summary

Implements \`lib/knowledge-graph/parser.ts\` — a pure TypeScript function that uses the TypeScript compiler API to extract code entities and local relationships from source files.

## What's included

- \`parseFile(filePath, content, repo): ParseResult\` — core parser function
- Extracts: \`FunctionDeclaration\`, \`ClassDeclaration\`, \`InterfaceDeclaration\`, \`TypeAliasDeclaration\`, \`EnumDeclaration\`, exported \`VariableStatement\`
- Extracts signatures (parameter types + return type) for functions and arrow function variables
- Extracts JSDoc/docstrings from all supported node types
- Extracts local relationships: \`extends\`, \`implements\` (with intra-file \`toId\` resolution)
- Stable entity IDs: \`{repo}:{filePath}:{kind}:{name}\`
- Unit tests covering all entity kinds, relationships, JSDoc, ID format, and export filtering

## Testing

\`\`\`
npm test -- --testPathPattern=knowledge-graph-parser
\`\`\`

All tests pass. No new dependencies required (\`typescript\` is already in the project).
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/typescript-ast-parser-code-entity-extraction
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If blocked on an unresolvable issue (e.g. TypeScript API version incompatibility, missing `typescript` package, ambiguous type definitions):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "build-typescript-ast-parser-code-entity-extraction",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message>",
      "filesChanged": ["lib/knowledge-graph/parser.ts", "lib/__tests__/knowledge-graph-parser.test.ts"]
    }
  }'
```