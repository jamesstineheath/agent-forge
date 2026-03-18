import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockStore = new Map<string, unknown>();

vi.mock('@/lib/storage', () => ({
  saveJson: async (key: string, data: unknown): Promise<void> => {
    mockStore.set(key, data);
  },
  loadJson: async (key: string): Promise<unknown> => {
    return mockStore.get(key) ?? null;
  },
  deleteJson: async (key: string): Promise<void> => {
    mockStore.delete(key);
  },
}));

import {
  saveGraph,
  loadGraph,
  saveRepoSnapshot,
  loadRepoSnapshot,
  deleteGraph,
} from '@/lib/knowledge-graph/storage';
import type { KnowledgeGraph, RepoSnapshot } from '@/lib/knowledge-graph/types';

const TEST_REPO = 'test-owner/test-repo';

describe('Knowledge Graph Storage', () => {
  beforeEach(() => {
    mockStore.clear();
  });

  describe('saveGraph / loadGraph', () => {
    it('round-trips a graph with a populated entities Map', async () => {
      const graph: KnowledgeGraph = {
        entities: new Map([
          [
            'e1',
            {
              id: 'e1',
              type: 'class',
              name: 'MyClass',
              filePath: 'src/my-class.ts',
              repo: TEST_REPO,
              startLine: 1,
              endLine: 50,
            },
          ],
          [
            'e2',
            {
              id: 'e2',
              type: 'function',
              name: 'myFunction',
              filePath: 'src/utils.ts',
              repo: TEST_REPO,
              startLine: 10,
              endLine: 20,
            },
          ],
        ]),
        relationships: [
          { id: 'e1:calls:e2', sourceId: 'e1', targetId: 'e2', type: 'calls' },
        ],
        repoSnapshots: [],
        lastUpdated: new Date('2024-01-01T00:00:00.000Z'),
      };

      await saveGraph(TEST_REPO, graph);
      const loaded = await loadGraph(TEST_REPO);

      expect(loaded).not.toBeNull();
      expect(loaded!.entities).toBeInstanceOf(Map);
      expect(loaded!.entities.size).toBe(2);
      expect(loaded!.entities.get('e1')).toMatchObject({
        id: 'e1',
        name: 'MyClass',
      });
      expect(loaded!.entities.get('e2')).toMatchObject({
        id: 'e2',
        name: 'myFunction',
      });
      expect(loaded!.relationships).toHaveLength(1);
      expect(loaded!.relationships[0]).toMatchObject({
        sourceId: 'e1',
        targetId: 'e2',
        type: 'calls',
      });
    });

    it('preserves lastUpdated through serialization', async () => {
      const graph: KnowledgeGraph = {
        entities: new Map(),
        relationships: [],
        repoSnapshots: [],
        lastUpdated: new Date('2024-06-15T10:30:00.000Z'),
      };

      await saveGraph(TEST_REPO, graph);
      const loaded = await loadGraph(TEST_REPO);

      expect(loaded!.lastUpdated).toEqual(new Date('2024-06-15T10:30:00.000Z'));
    });

    it('returns null for a nonexistent repo', async () => {
      const result = await loadGraph('nonexistent/repo');
      expect(result).toBeNull();
    });

    it('saves to the correct storage key with schemaVersion', async () => {
      const graph: KnowledgeGraph = {
        entities: new Map(),
        relationships: [],
        repoSnapshots: [],
        lastUpdated: new Date(),
      };

      await saveGraph(TEST_REPO, graph);

      const stored = mockStore.get('knowledge-graph/test-owner/test-repo/graph');
      expect(stored).toMatchObject({ schemaVersion: 1 });
    });
  });

  describe('saveRepoSnapshot / loadRepoSnapshot', () => {
    it('round-trips a RepoSnapshot', async () => {
      const snapshot: RepoSnapshot = {
        repo: TEST_REPO,
        commitSha: 'abc123def456',
        indexedAt: new Date('2024-01-15T12:00:00.000Z'),
        entityCount: 42,
        relationshipCount: 18,
      };

      await saveRepoSnapshot(snapshot);
      const loaded = await loadRepoSnapshot(TEST_REPO);

      expect(loaded).not.toBeNull();
      expect(loaded!.repo).toBe(TEST_REPO);
      expect(loaded!.commitSha).toBe('abc123def456');
      expect(loaded!.entityCount).toBe(42);
      expect(loaded!.relationshipCount).toBe(18);
    });

    it('returns null for a nonexistent repo snapshot', async () => {
      const result = await loadRepoSnapshot('nonexistent/repo');
      expect(result).toBeNull();
    });
  });

  describe('deleteGraph', () => {
    it('removes both graph and snapshot for a repo', async () => {
      const graph: KnowledgeGraph = {
        entities: new Map(),
        relationships: [],
        repoSnapshots: [],
        lastUpdated: new Date(),
      };
      const snapshot: RepoSnapshot = {
        repo: TEST_REPO,
        commitSha: 'abc123',
        indexedAt: new Date(),
        entityCount: 0,
        relationshipCount: 0,
      };

      await saveGraph(TEST_REPO, graph);
      await saveRepoSnapshot(snapshot);

      expect(await loadGraph(TEST_REPO)).not.toBeNull();
      expect(await loadRepoSnapshot(TEST_REPO)).not.toBeNull();

      await deleteGraph(TEST_REPO);

      expect(await loadGraph(TEST_REPO)).toBeNull();
      expect(await loadRepoSnapshot(TEST_REPO)).toBeNull();
    });

    it('does not throw when deleting a nonexistent repo', async () => {
      await expect(deleteGraph('nonexistent/repo')).resolves.not.toThrow();
    });
  });
});
