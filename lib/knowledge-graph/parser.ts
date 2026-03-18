/**
 * TypeScript AST parser for code entity extraction.
 * Pure function — no I/O, no side effects.
 */
import * as ts from 'typescript';
import type { CodeEntity, CodeRelationship, EntityType, RelationshipType } from './types';

// ---------------------------------------------------------------------------
// Parser-specific types
// ---------------------------------------------------------------------------

export interface ParseResult {
  entities: CodeEntity[];
  localRelationships: CodeRelationship[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeId(repo: string, filePath: string, type: EntityType, name: string): string {
  return `${repo}:${filePath}:${type}:${name}`;
}

function getLineNumbers(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): { startLine: number; endLine: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    startLine: start.line + 1,
    endLine: end.line + 1,
  };
}

function getJsDoc(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  const fullText = sourceFile.getFullText();
  const nodeStart = node.getFullStart();
  const leadingTrivia = fullText.slice(nodeStart, node.getStart(sourceFile));
  const jsDocMatch = leadingTrivia.match(/\/\*\*([\s\S]*?)\*\//);
  if (jsDocMatch) {
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
  sourceFile: ts.SourceFile,
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
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseFile(filePath: string, content: string, repo: string): ParseResult {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS,
  );

  const entities: CodeEntity[] = [];
  const localRelationships: CodeRelationship[] = [];

  function visit(node: ts.Node): void {
    // --- FunctionDeclaration (exported only) ---
    if (ts.isFunctionDeclaration(node) && node.name && isExported(node)) {
      const name = node.name.getText(sourceFile);
      const { startLine, endLine } = getLineNumbers(node, sourceFile);
      entities.push({
        id: makeId(repo, filePath, 'function', name),
        name,
        type: 'function',
        filePath,
        repo,
        startLine,
        endLine,
        signature: getFunctionSignature(node, sourceFile),
        docstring: getJsDoc(node, sourceFile),
      });
    }

    // --- ClassDeclaration ---
    else if (ts.isClassDeclaration(node) && node.name && isExported(node)) {
      const name = node.name.getText(sourceFile);
      const { startLine, endLine } = getLineNumbers(node, sourceFile);
      const id = makeId(repo, filePath, 'class', name);
      entities.push({
        id,
        name,
        type: 'class',
        filePath,
        repo,
        startLine,
        endLine,
        docstring: getJsDoc(node, sourceFile),
      });

      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          const relType: RelationshipType =
            clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
          for (const hType of clause.types) {
            const targetName = hType.expression.getText(sourceFile);
            const targetId = `unresolved:${targetName}`;
            localRelationships.push({
              id: `${id}:${relType}:${targetId}`,
              sourceId: id,
              targetId,
              type: relType,
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
        id: makeId(repo, filePath, 'type', name),
        name,
        type: 'type',
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
        id: makeId(repo, filePath, 'type', name),
        name,
        type: 'type',
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
        id: makeId(repo, filePath, 'type', name),
        name,
        type: 'type',
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
            type: 'variable',
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

  // Resolve local relationship targets where possible
  const entityById = new Map(entities.map((e) => [e.name, e.id]));
  for (const rel of localRelationships) {
    if (rel.targetId.startsWith('unresolved:')) {
      const targetName = rel.targetId.slice('unresolved:'.length);
      const resolvedId = entityById.get(targetName);
      if (resolvedId) {
        (rel as { targetId: string }).targetId = resolvedId;
        (rel as { id: string }).id = `${rel.sourceId}:${rel.type}:${resolvedId}`;
      }
    }
  }

  return { entities, localRelationships };
}
