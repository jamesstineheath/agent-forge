import { describe, it, expect } from 'vitest';
import type {
  KnowledgeGraph,
  CodeEntity,
  CodeRelationship,
  EntityType,
  RelationshipType,
} from '@/lib/knowledge-graph/types';
import {
  queryGraph,
  findRelated,
  findDependents,
  findDependencies,
  getFileEntities,
  getCallChain,
} from '@/lib/knowledge-graph/query';

// ---------------------------------------------------------------------------
// Test graph builder
// ---------------------------------------------------------------------------

function makeEntity(
  name: string,
  type: EntityType,
  filePath: string,
  startLine = 1,
  endLine = 10,
): CodeEntity {
  const repo = 'test-owner/test-repo';
  return {
    id: `${repo}:${filePath}:${type}:${name}`,
    type,
    name,
    filePath,
    repo,
    startLine,
    endLine,
  };
}

function makeRel(
  source: CodeEntity,
  target: CodeEntity,
  type: RelationshipType,
): CodeRelationship {
  return {
    id: `${source.id}:${type}:${target.id}`,
    sourceId: source.id,
    targetId: target.id,
    type,
  };
}

// Entities (11 total)
const FuncA = makeEntity('FuncA', 'function', 'src/a.ts', 1, 10);
const ClassA = makeEntity('ClassA', 'class', 'src/a.ts', 12, 30);
const FuncB = makeEntity('FuncB', 'function', 'src/b.ts', 1, 15);
const FuncC = makeEntity('FuncC', 'function', 'src/b.ts', 17, 30);
const FuncD = makeEntity('FuncD', 'function', 'src/c.ts', 1, 20);
const FuncE = makeEntity('FuncE', 'function', 'src/c.ts', 22, 40);
const InterfaceI = makeEntity('InterfaceI', 'type', 'src/c.ts', 42, 50);
const FuncF = makeEntity('FuncF', 'function', 'src/d.ts', 1, 25);
const ClassB = makeEntity('ClassB', 'class', 'src/e.ts', 1, 30);
const FuncG = makeEntity('FuncG', 'function', 'src/e.ts', 32, 50);
const FuncH = makeEntity('FuncH', 'function', 'src/e.ts', 52, 70);

const allEntities: CodeEntity[] = [
  FuncA, ClassA, FuncB, FuncC, FuncD, FuncE, InterfaceI, FuncF, ClassB, FuncG, FuncH,
];

// Relationships (15 total)
const relationships: CodeRelationship[] = [
  makeRel(FuncA, ClassA, 'imports'),    // 1
  makeRel(FuncB, FuncA, 'imports'),     // 2
  makeRel(FuncC, FuncA, 'imports'),     // 3
  makeRel(FuncD, FuncB, 'imports'),     // 4
  makeRel(FuncD, FuncB, 'calls'),       // 5
  makeRel(FuncE, FuncC, 'calls'),       // 6
  makeRel(FuncF, FuncD, 'imports'),     // 7
  makeRel(FuncF, FuncD, 'calls'),       // 8
  makeRel(ClassB, InterfaceI, 'implements'), // 9
  makeRel(FuncG, FuncF, 'calls'),       // 10
  makeRel(FuncH, FuncG, 'calls'),       // 11
  makeRel(ClassA, InterfaceI, 'implements'), // 12
  makeRel(FuncB, FuncC, 'calls'),       // 13
  makeRel(FuncC, FuncD, 'calls'),       // 14
  makeRel(FuncA, FuncE, 'calls'),       // 15
];

function buildTestGraph(): KnowledgeGraph {
  const entityMap = new Map<string, CodeEntity>();
  for (const e of allEntities) {
    entityMap.set(e.id, e);
  }
  return {
    entities: entityMap,
    relationships,
    repoSnapshots: [],
    lastUpdated: new Date('2026-01-01'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Knowledge Graph Query Engine', () => {
  const graph = buildTestGraph();

  // --- queryGraph ---

  describe('queryGraph', () => {
    it('returns all entities when query is empty', () => {
      const result = queryGraph(graph, {});
      expect(result.entities).toHaveLength(allEntities.length);
      expect(result.totalCount).toBe(allEntities.length);
    });

    it('filters by entityType', () => {
      const result = queryGraph(graph, { entityType: 'class' });
      expect(result.entities).toHaveLength(2);
      expect(result.entities.map((e) => e.name).sort()).toEqual(['ClassA', 'ClassB']);
    });

    it('filters by namePattern (regex)', () => {
      const result = queryGraph(graph, { namePattern: '^Func[A-C]$' });
      expect(result.entities).toHaveLength(3);
      expect(result.entities.map((e) => e.name).sort()).toEqual(['FuncA', 'FuncB', 'FuncC']);
    });

    it('filters by filePath (exact)', () => {
      const result = queryGraph(graph, { filePath: 'src/b.ts' });
      expect(result.entities).toHaveLength(2);
      expect(result.entities.map((e) => e.name).sort()).toEqual(['FuncB', 'FuncC']);
    });

    it('filters by filePath (glob with *)', () => {
      const result = queryGraph(graph, { filePath: 'src/*.ts' });
      expect(result.entities).toHaveLength(allEntities.length);
    });

    it('filters by combined entityType + filePath', () => {
      const result = queryGraph(graph, { entityType: 'function', filePath: 'src/c.ts' });
      expect(result.entities).toHaveLength(2);
      expect(result.entities.map((e) => e.name).sort()).toEqual(['FuncD', 'FuncE']);
    });

    it('returns empty for unknown relatedTo entity', () => {
      const result = queryGraph(graph, { relatedTo: 'nonexistent:id' });
      expect(result.entities).toHaveLength(0);
      expect(result.relationships).toHaveLength(0);
    });

    it('filters by relatedTo with depth', () => {
      const result = queryGraph(graph, { relatedTo: FuncA.id, depth: 1 });
      // FuncA is connected to: ClassA (imports), FuncB (imports from FuncA),
      // FuncC (imports from FuncA), FuncE (calls)
      expect(result.entities.length).toBeGreaterThanOrEqual(3);
      const names = result.entities.map((e) => e.name);
      expect(names).toContain('ClassA');
      expect(names).toContain('FuncE');
    });
  });

  // --- findRelated ---

  describe('findRelated', () => {
    it('returns direct neighbors at depth=1', () => {
      const result = findRelated(graph, FuncD.id, { depth: 1 });
      const names = result.entities.map((e) => e.name).sort();
      // FuncD: imports FuncB, calls FuncB, FuncF imports/calls FuncD, FuncC calls FuncD
      expect(names).toContain('FuncB');
      expect(names).toContain('FuncF');
      expect(names).toContain('FuncC');
    });

    it('returns second-hop entities at depth=2', () => {
      const result = findRelated(graph, FuncF.id, { depth: 2 });
      // Depth 1: FuncD (imports/calls), FuncG (calls FuncF)
      // Depth 2 from FuncD: FuncB, FuncC; from FuncG: FuncH
      const names = result.entities.map((e) => e.name);
      expect(names).toContain('FuncD');
      expect(names).toContain('FuncG');
      expect(names).toContain('FuncB');
      expect(names).toContain('FuncH');
    });

    it('returns empty for unknown entityId', () => {
      const result = findRelated(graph, 'nonexistent:id');
      expect(result.entities).toHaveLength(0);
      expect(result.relationships).toHaveLength(0);
    });

    it('filters by relationship types', () => {
      const result = findRelated(graph, FuncD.id, {
        depth: 1,
        relationshipTypes: ['calls'],
      });
      const names = result.entities.map((e) => e.name);
      // Only call relationships: FuncD calls FuncB, FuncF calls FuncD, FuncC calls FuncD
      expect(names).toContain('FuncB');
      expect(names).toContain('FuncF');
      expect(names).toContain('FuncC');
    });
  });

  // --- findDependents ---

  describe('findDependents', () => {
    it('returns entities that point TO the given entity', () => {
      // FuncA is targeted by: FuncB (imports), FuncC (imports)
      const result = findDependents(graph, FuncA.id);
      const names = result.map((e) => e.name).sort();
      expect(names).toContain('FuncB');
      expect(names).toContain('FuncC');
    });

    it('returns empty for entity with no dependents', () => {
      const result = findDependents(graph, FuncH.id);
      expect(result).toHaveLength(0);
    });

    it('returns empty for unknown entityId', () => {
      const result = findDependents(graph, 'nonexistent:id');
      expect(result).toHaveLength(0);
    });
  });

  // --- findDependencies ---

  describe('findDependencies', () => {
    it('returns entities the given entity points TO', () => {
      // FuncD imports FuncB, calls FuncB
      const result = findDependencies(graph, FuncD.id);
      const names = result.map((e) => e.name);
      expect(names).toContain('FuncB');
    });

    it('returns empty for unknown entityId', () => {
      const result = findDependencies(graph, 'nonexistent:id');
      expect(result).toHaveLength(0);
    });
  });

  // --- getFileEntities ---

  describe('getFileEntities', () => {
    it('returns all entities in a file', () => {
      const result = getFileEntities(graph, 'src/c.ts');
      expect(result).toHaveLength(3);
      expect(result.map((e) => e.name).sort()).toEqual(['FuncD', 'FuncE', 'InterfaceI']);
    });

    it('returns empty for unknown file', () => {
      const result = getFileEntities(graph, 'src/nonexistent.ts');
      expect(result).toHaveLength(0);
    });
  });

  // --- getCallChain ---

  describe('getCallChain', () => {
    it('returns callee chains', () => {
      // FuncH calls FuncG, FuncG calls FuncF, FuncF calls FuncD, FuncD calls FuncB
      const chains = getCallChain(graph, FuncH.id, 'callees');
      expect(chains.length).toBeGreaterThanOrEqual(1);
      // Should have path: FuncG -> FuncF -> FuncD -> FuncB -> FuncC
      const longestChain = chains.reduce((a, b) => (a.length > b.length ? a : b), []);
      expect(longestChain.map((e) => e.name)).toEqual(['FuncG', 'FuncF', 'FuncD', 'FuncB', 'FuncC']);
    });

    it('returns caller chains', () => {
      // FuncB is called by: FuncD (calls FuncB)
      // FuncD is called by: FuncF, FuncC
      const chains = getCallChain(graph, FuncB.id, 'callers');
      expect(chains.length).toBeGreaterThanOrEqual(1);
      const chainNames = chains.map((c) => c.map((e) => e.name));
      // Should contain [FuncD] and paths through FuncD
      expect(chainNames).toContainEqual(['FuncD']);
    });

    it('respects maxDepth', () => {
      const chains = getCallChain(graph, FuncH.id, 'callees', 2);
      for (const chain of chains) {
        expect(chain.length).toBeLessThanOrEqual(2);
      }
      // Should have [FuncG] and [FuncG, FuncF]
      const chainNames = chains.map((c) => c.map((e) => e.name));
      expect(chainNames).toContainEqual(['FuncG']);
      expect(chainNames).toContainEqual(['FuncG', 'FuncF']);
    });

    it('returns empty for unknown entityId', () => {
      const chains = getCallChain(graph, 'nonexistent:id', 'callees');
      expect(chains).toHaveLength(0);
    });

    it('returns empty for null/undefined graph or entityId', () => {
      expect(getCallChain(null as unknown as KnowledgeGraph, 'x', 'callees')).toEqual([]);
      expect(getCallChain(graph, '', 'callees')).toEqual([]);
      expect(getCallChain(graph, undefined as unknown as string, 'callers')).toEqual([]);
    });

    it('handles cycles without infinite loop', () => {
      // Create a graph with a cycle: X calls Y, Y calls X
      const X = makeEntity('X', 'function', 'src/cycle.ts', 1, 5);
      const Y = makeEntity('Y', 'function', 'src/cycle.ts', 7, 12);
      const cycleGraph: KnowledgeGraph = {
        entities: new Map([
          [X.id, X],
          [Y.id, Y],
        ]),
        relationships: [makeRel(X, Y, 'calls'), makeRel(Y, X, 'calls')],
        repoSnapshots: [],
        lastUpdated: new Date('2026-01-01'),
      };

      // Should not hang and should produce finite results
      const chains = getCallChain(cycleGraph, X.id, 'callees', 5);
      expect(chains.length).toBeGreaterThanOrEqual(1);
      // The only callee chain should be [Y], since going back to X is a cycle
      const chainNames = chains.map((c) => c.map((e) => e.name));
      expect(chainNames).toContainEqual(['Y']);
      // No chain should contain X (the start entity)
      for (const chain of chains) {
        expect(chain.map((e) => e.name)).not.toContain('X');
      }
    });
  });

  // --- Graceful handling of invalid inputs ---

  describe('graceful null/undefined handling', () => {
    const nullGraph = null as unknown as KnowledgeGraph;
    const undefinedId = undefined as unknown as string;

    it('queryGraph returns empty for null graph', () => {
      const result = queryGraph(nullGraph, {});
      expect(result.entities).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });

    it('findRelated returns empty for null graph', () => {
      const result = findRelated(nullGraph, 'x');
      expect(result.entities).toHaveLength(0);
    });

    it('findRelated returns empty for undefined entityId', () => {
      const result = findRelated(graph, undefinedId);
      expect(result.entities).toHaveLength(0);
    });

    it('findDependents returns empty for null graph', () => {
      expect(findDependents(nullGraph, 'x')).toEqual([]);
    });

    it('findDependencies returns empty for undefined entityId', () => {
      expect(findDependencies(graph, undefinedId)).toEqual([]);
    });

    it('getFileEntities returns empty for null graph', () => {
      expect(getFileEntities(nullGraph, 'x')).toEqual([]);
    });

    it('getFileEntities returns empty for empty filePath', () => {
      expect(getFileEntities(graph, '')).toEqual([]);
    });
  });
});
