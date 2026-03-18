import { describe, it, expect } from 'vitest';
import {
  extractImports,
  buildEntityIndex,
  resolveRelationships,
  ImportInfo,
} from '../knowledge-graph/resolver';
import { CodeEntity } from '../knowledge-graph/types';

// ---------------------------------------------------------------------------
// Helper to create mock CodeEntity objects
// ---------------------------------------------------------------------------
function mockEntity(
  overrides: Partial<CodeEntity> & Pick<CodeEntity, 'id' | 'name' | 'filePath' | 'type'>,
): CodeEntity {
  return {
    repo: 'test/repo',
    startLine: 1,
    endLine: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test scenario: three interconnected files
//
// fileA.ts  exports: function `parseConfig` (default), class `Config` (named)
// fileB.ts  imports: default from fileA, named `Config` from fileA; exports: type `Options`
// fileC.ts  imports: `Options` type from fileB, namespace import from fileA, re-exports from fileB
// ---------------------------------------------------------------------------

const fileAPath = '/repo/src/fileA.ts';
const fileBPath = '/repo/src/fileB.ts';
const fileCPath = '/repo/src/fileC.ts';

const entityA1 = mockEntity({
  id: 'test/repo:src/fileA.ts:function:parseConfig:1',
  name: 'parseConfig',
  filePath: fileAPath,
  type: 'function',
});

const entityA2 = mockEntity({
  id: 'test/repo:src/fileA.ts:class:Config:15',
  name: 'Config',
  filePath: fileAPath,
  type: 'class',
  startLine: 15,
  endLine: 40,
});

const entityB1 = mockEntity({
  id: 'test/repo:src/fileB.ts:type:Options:1',
  name: 'Options',
  filePath: fileBPath,
  type: 'type',
});

const entityC1 = mockEntity({
  id: 'test/repo:src/fileC.ts:module:fileC:1',
  name: 'fileC',
  filePath: fileCPath,
  type: 'module',
});

const allEntities = [entityA1, entityA2, entityB1, entityC1];

// ---------------------------------------------------------------------------
// extractImports
// ---------------------------------------------------------------------------
describe('extractImports', () => {
  it('parses named import with alias', () => {
    const content = `import { Config as AppConfig } from './fileA';`;
    const result = extractImports('/repo/src/fileB.ts', content);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('./fileA');
    expect(result[0].specifiers).toEqual([
      { name: 'Config', alias: 'AppConfig', isDefault: false },
    ]);
    expect(result[0].isTypeOnly).toBe(false);
  });

  it('parses default import', () => {
    const content = `import parseConfig from './fileA';`;
    const result = extractImports('/repo/src/fileB.ts', content);
    expect(result).toHaveLength(1);
    expect(result[0].specifiers).toEqual([
      { name: 'parseConfig', isDefault: true },
    ]);
  });

  it('parses namespace import', () => {
    const content = `import * as fileAAll from './fileA';`;
    const result = extractImports('/repo/src/fileC.ts', content);
    expect(result).toHaveLength(1);
    expect(result[0].specifiers).toEqual([
      { name: '*', alias: 'fileAAll', isDefault: false },
    ]);
  });

  it('parses type-only import', () => {
    const content = `import type { Options } from './fileB';`;
    const result = extractImports('/repo/src/fileC.ts', content);
    expect(result).toHaveLength(1);
    expect(result[0].isTypeOnly).toBe(true);
    expect(result[0].specifiers).toEqual([
      { name: 'Options', isDefault: false },
    ]);
  });

  it('parses re-export statement', () => {
    const content = `export { Options } from './fileB';`;
    const result = extractImports('/repo/src/fileC.ts', content);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('./fileB');
    expect(result[0].specifiers).toEqual([
      { name: 'Options', isDefault: false },
    ]);
  });

  it('parses bare specifier and returns source as-is', () => {
    const content = `import React from 'react';`;
    const result = extractImports('/repo/src/fileC.ts', content);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('react');
    expect(result[0].specifiers[0].isDefault).toBe(true);
  });

  it('parses combined default + named import', () => {
    const content = `import parseConfig, { Config } from './fileA';`;
    const result = extractImports('/repo/src/fileB.ts', content);
    // Should produce one ImportInfo with both specifiers
    const combined = result.find((r) => r.specifiers.length > 1);
    expect(combined).toBeDefined();
    expect(combined!.specifiers[0]).toEqual({ name: 'parseConfig', isDefault: true });
    expect(combined!.specifiers[1]).toEqual({ name: 'Config', isDefault: false });
  });

  it('parses export * from', () => {
    const content = `export * from './fileB';`;
    const result = extractImports('/repo/src/fileC.ts', content);
    expect(result).toHaveLength(1);
    expect(result[0].specifiers).toEqual([{ name: '*', isDefault: false }]);
  });

  it('handles multi-line imports', () => {
    const content = `import {
  Config,
  parseConfig
} from './fileA';`;
    const result = extractImports('/repo/src/fileB.ts', content);
    expect(result).toHaveLength(1);
    expect(result[0].specifiers).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// buildEntityIndex
// ---------------------------------------------------------------------------
describe('buildEntityIndex', () => {
  it('indexes entities by file path with multiple entities per file', () => {
    const index = buildEntityIndex(allEntities);
    const fileAEntities = index.get(fileAPath);
    expect(fileAEntities).toHaveLength(2);
    expect(fileAEntities![0].name).toBe('parseConfig');
    expect(fileAEntities![1].name).toBe('Config');

    const fileBEntities = index.get(fileBPath);
    expect(fileBEntities).toHaveLength(1);
    expect(fileBEntities![0].name).toBe('Options');
  });
});

// ---------------------------------------------------------------------------
// resolveRelationships
// ---------------------------------------------------------------------------
describe('resolveRelationships', () => {
  const entityIndex = buildEntityIndex(allEntities);

  it('creates relationship for named import with correct sourceId/targetId', () => {
    const imports: ImportInfo[] = [
      {
        source: './fileA',
        specifiers: [{ name: 'Config', isDefault: false }],
        isTypeOnly: false,
        filePath: fileBPath,
      },
    ];
    const rels = resolveRelationships(imports, entityIndex);
    expect(rels).toHaveLength(1);
    expect(rels[0].sourceId).toBe(entityB1.id);
    expect(rels[0].targetId).toBe(entityA2.id);
    expect(rels[0].type).toBe('imports');
  });

  it('sets metadata.isTypeOnly true for type-only imports', () => {
    const imports: ImportInfo[] = [
      {
        source: './fileB',
        specifiers: [{ name: 'Options', isDefault: false }],
        isTypeOnly: true,
        filePath: fileCPath,
      },
    ];
    const rels = resolveRelationships(imports, entityIndex);
    expect(rels).toHaveLength(1);
    expect(rels[0].metadata?.isTypeOnly).toBe(true);
    expect(rels[0].metadata?.specifier).toBe('Options');
  });

  it('skips bare specifier imports', () => {
    const imports: ImportInfo[] = [
      {
        source: 'react',
        specifiers: [{ name: 'React', isDefault: true }],
        isTypeOnly: false,
        filePath: fileCPath,
      },
    ];
    const rels = resolveRelationships(imports, entityIndex);
    expect(rels).toHaveLength(0);
  });

  it('creates relationship for namespace import', () => {
    const imports: ImportInfo[] = [
      {
        source: './fileA',
        specifiers: [{ name: '*', alias: 'fileAAll', isDefault: false }],
        isTypeOnly: false,
        filePath: fileCPath,
      },
    ];
    const rels = resolveRelationships(imports, entityIndex);
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toBe(entityA1.id); // first entity in fileA
    expect(rels[0].metadata?.specifier).toBe('fileAAll');
  });

  it('creates unknown targetId when entity not found', () => {
    const imports: ImportInfo[] = [
      {
        source: './fileA',
        specifiers: [{ name: 'NonExistent', isDefault: false }],
        isTypeOnly: false,
        filePath: fileBPath,
      },
    ];
    const rels = resolveRelationships(imports, entityIndex);
    expect(rels).toHaveLength(1);
    expect(rels[0].targetId).toContain(':unknown');
  });

  // --------------------------------------------------------------------------
  // Integration: 3-file graph
  // --------------------------------------------------------------------------
  it('resolves full 3-file graph with correct connectivity', () => {
    // fileB imports default parseConfig + named Config from fileA
    const fileBContent = `import parseConfig, { Config } from './fileA';`;
    const fileBImports = extractImports(fileBPath, fileBContent);

    // fileC imports type Options from fileB, namespace from fileA, re-exports from fileB
    const fileCContent = [
      `import type { Options } from './fileB';`,
      `import * as fileAAll from './fileA';`,
      `export { Options } from './fileB';`,
    ].join('\n');
    const fileCImports = extractImports(fileCPath, fileCContent);

    const allImports = [...fileBImports, ...fileCImports];
    const rels = resolveRelationships(allImports, entityIndex);

    // fileB → fileA: parseConfig (default), Config (named)
    const fileBToA = rels.filter((r) => r.sourceId === entityB1.id && r.targetId.includes('fileA'));
    expect(fileBToA.length).toBeGreaterThanOrEqual(2);

    // fileC → fileB: Options (type-only)
    const fileCToB = rels.filter(
      (r) => r.sourceId === entityC1.id && r.metadata?.isTypeOnly === true,
    );
    expect(fileCToB.length).toBeGreaterThanOrEqual(1);

    // fileC → fileA: namespace
    const fileCToA = rels.filter(
      (r) => r.sourceId === entityC1.id && r.metadata?.specifier === 'fileAAll',
    );
    expect(fileCToA).toHaveLength(1);

    // Total relationships: at least 5 (2 from fileB, 3 from fileC)
    expect(rels.length).toBeGreaterThanOrEqual(5);

    // All relationships have type 'imports'
    expect(rels.every((r) => r.type === 'imports')).toBe(true);
  });
});
