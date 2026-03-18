import path from 'path';
import { CodeEntity, CodeRelationship } from './types';

export interface ImportSpecifier {
  name: string;
  alias?: string;
  isDefault: boolean;
}

export interface ImportInfo {
  source: string;
  specifiers: ImportSpecifier[];
  isTypeOnly: boolean;
  filePath: string;
}

/**
 * Regex-based extraction of import/export-from statements from TypeScript source.
 * Returns an empty array on parse errors.
 */
export function extractImports(filePath: string, content: string): ImportInfo[] {
  const results: ImportInfo[] = [];

  try {
    // Collapse multiline statements: replace newlines inside import/export statements
    const normalized = content.replace(/\n/g, ' ');

    // Named imports: import [type] { ... } from '...'
    const namedRe = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = namedRe.exec(normalized)) !== null) {
      const isTypeOnly = !!m[1];
      const specifiers = parseNamedSpecifiers(m[2], false);
      results.push({ source: m[3], specifiers, isTypeOnly, filePath });
    }

    // Default import: import [type] Name from '...'
    // Must not match `import { ... }` or `import * as` or `import type {`
    const defaultRe = /import\s+(type\s+)?([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g;
    while ((m = defaultRe.exec(normalized)) !== null) {
      const isTypeOnly = !!m[1];
      const name = m[2];
      // Check this isn't part of a combined import (handled separately)
      // by checking that the char after the name isn't a comma
      const afterMatch = normalized.slice(m.index + m[0].length);
      // This is a pure default import (no combined)
      results.push({
        source: m[3],
        specifiers: [{ name, isDefault: true }],
        isTypeOnly,
        filePath,
      });
    }

    // Namespace import: import * as ns from '...'
    const nsRe = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
    while ((m = nsRe.exec(normalized)) !== null) {
      results.push({
        source: m[2],
        specifiers: [{ name: '*', alias: m[1], isDefault: false }],
        isTypeOnly: false,
        filePath,
      });
    }

    // Combined: import [type] Default, { ... } from '...'
    const combinedRe = /import\s+(type\s+)?([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
    while ((m = combinedRe.exec(normalized)) !== null) {
      const isTypeOnly = !!m[1];
      const defaultName = m[2];
      const namedSpecs = parseNamedSpecifiers(m[3], false);
      const specifiers: ImportSpecifier[] = [
        { name: defaultName, isDefault: true },
        ...namedSpecs,
      ];
      results.push({ source: m[4], specifiers, isTypeOnly, filePath });
    }

    // Re-export named: export [type] { ... } from '...'
    const reExportNamedRe = /export\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
    while ((m = reExportNamedRe.exec(normalized)) !== null) {
      const isTypeOnly = !!m[1];
      const specifiers = parseNamedSpecifiers(m[2], false);
      results.push({ source: m[3], specifiers, isTypeOnly, filePath });
    }

    // Re-export all: export * from '...'
    const reExportAllRe = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
    while ((m = reExportAllRe.exec(normalized)) !== null) {
      results.push({
        source: m[1],
        specifiers: [{ name: '*', isDefault: false }],
        isTypeOnly: false,
        filePath,
      });
    }

    // Re-export namespace: export * as ns from '...'
    const reExportNsRe = /export\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
    while ((m = reExportNsRe.exec(normalized)) !== null) {
      results.push({
        source: m[2],
        specifiers: [{ name: '*', alias: m[1], isDefault: false }],
        isTypeOnly: false,
        filePath,
      });
    }

    // Deduplicate: combined imports will also match default regex, so remove pure defaults
    // that have the same source as a combined import
    const combinedSources = new Set<string>();
    for (const r of results) {
      if (r.specifiers.length > 1 && r.specifiers[0].isDefault) {
        combinedSources.add(r.source);
      }
    }
    // Also, re-export * as ns will match re-export *, so deduplicate
    const nsReExportSources = new Set<string>();
    for (const r of results) {
      if (r.specifiers.length === 1 && r.specifiers[0].name === '*' && r.specifiers[0].alias) {
        nsReExportSources.add(r.source);
      }
    }

    return results.filter((r) => {
      // Remove pure default imports that are actually part of combined imports
      if (
        r.specifiers.length === 1 &&
        r.specifiers[0].isDefault &&
        combinedSources.has(r.source)
      ) {
        return false;
      }
      // Remove plain re-export * that also has a namespace re-export
      if (
        r.specifiers.length === 1 &&
        r.specifiers[0].name === '*' &&
        !r.specifiers[0].alias &&
        nsReExportSources.has(r.source)
      ) {
        return false;
      }
      return true;
    });
  } catch {
    return [];
  }
}

function parseNamedSpecifiers(raw: string, _isDefault: boolean): ImportSpecifier[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const asMatch = s.match(/^(\S+)\s+as\s+(\S+)$/);
      if (asMatch) {
        return { name: asMatch[1], alias: asMatch[2], isDefault: false };
      }
      return { name: s, isDefault: false };
    });
}

/**
 * Builds a Map<normalizedFilePath, CodeEntity[]> for O(1) file-level lookups.
 */
export function buildEntityIndex(allEntities: CodeEntity[]): Map<string, CodeEntity[]> {
  const index = new Map<string, CodeEntity[]>();
  for (const entity of allEntities) {
    const key = path.normalize(entity.filePath);
    const existing = index.get(key);
    if (existing) {
      existing.push(entity);
    } else {
      index.set(key, [entity]);
    }
  }
  return index;
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'];

function isBareSpecifier(source: string): boolean {
  return !source.startsWith('./') && !source.startsWith('../') && !source.startsWith('/');
}

/**
 * Resolves ImportInfo[] against an entity index to produce CodeRelationship edges.
 * Bare specifiers (npm packages) are skipped.
 */
export function resolveRelationships(
  imports: ImportInfo[],
  entityIndex: Map<string, CodeEntity[]>,
): CodeRelationship[] {
  const relationships: CodeRelationship[] = [];

  for (const imp of imports) {
    if (isBareSpecifier(imp.source)) continue;

    const basePath = path.resolve(path.dirname(imp.filePath), imp.source);

    // Try to find target entities
    let targetEntities: CodeEntity[] | undefined;
    let resolvedPath: string = basePath;

    // Try exact match first, then with extensions
    targetEntities = entityIndex.get(path.normalize(basePath));
    if (!targetEntities) {
      for (const ext of EXTENSIONS) {
        const candidate = path.normalize(basePath + ext);
        targetEntities = entityIndex.get(candidate);
        if (targetEntities) {
          resolvedPath = candidate;
          break;
        }
      }
    } else {
      resolvedPath = path.normalize(basePath);
    }

    // Find the importing file's entity to use as sourceId
    const importingFileNorm = path.normalize(imp.filePath);
    const importingEntities = entityIndex.get(importingFileNorm);
    const sourceEntity = importingEntities?.[0];
    const sourceId = sourceEntity?.id ?? `${importingFileNorm}:file`;

    for (const spec of imp.specifiers) {
      let targetId: string;

      if (targetEntities && targetEntities.length > 0) {
        if (spec.name === '*') {
          // Namespace: point to file's first entity
          targetId = targetEntities[0].id;
        } else if (spec.isDefault) {
          // Default: look for an entity with matching name
          const match = targetEntities.find((e) => e.name === spec.name) ?? targetEntities[0];
          targetId = match.id;
        } else {
          // Named: match by name
          const match = targetEntities.find((e) => e.name === spec.name);
          targetId = match?.id ?? `${resolvedPath}:unknown`;
        }
      } else {
        targetId = `${resolvedPath}:unknown`;
      }

      const rel: CodeRelationship = {
        id: `${sourceId}:imports:${targetId}:${spec.name}`,
        sourceId,
        targetId,
        type: 'imports',
        metadata: {
          isTypeOnly: imp.isTypeOnly,
          specifier: spec.alias ?? spec.name,
        },
      };
      relationships.push(rel);
    }
  }

  return relationships;
}
