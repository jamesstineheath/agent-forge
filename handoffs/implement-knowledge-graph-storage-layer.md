# Agent Forge -- Implement Knowledge Graph Storage Layer

## Metadata
- **Branch:** `feat/knowledge-graph-storage-layer`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/knowledge-graph/storage.ts, lib/__tests__/knowledge-graph-storage.test.ts

## Context

Agent Forge is a Next.js dev orchestration platform using Vercel Blob for persistence. The storage layer follows patterns established in `lib/storage.ts`, which provides `put`, `get`, and `del` helpers over Vercel Blob.

A Knowledge Graph subsystem is being built out. The core types have already been defined in `lib/knowledge-graph/types.ts` (from a recently merged PR: "define Knowledge Graph core types and schema"). The storage layer needs to be built next.

The `KnowledgeGraph` type contains an `entities` field that is a `Map<string, Entity>`. Maps are not JSON-serializable by default, so custom serialization/deserialization is required. Relationships are likely stored as an array or plain object and should serialize cleanly.

**No concurrent work conflicts:** The concurrent work item (`feat/implement-debate-orchestrator-runs-multi-round-deb`) only touches `lib/debate/orchestrator.ts` — no overlap with this task.

## Requirements

1. Create `lib/knowledge-graph/storage.ts` that exports five functions: `saveGraph`, `loadGraph`, `saveRepoSnapshot`, `loadRepoSnapshot`, and `deleteGraph`.
2. `saveGraph(repo: string, graph: KnowledgeGraph): Promise<void>` — Serialize the graph (including Map→plain-object conversion for `entities`) and save to `af-data/knowledge-graph/{owner}/{repo}/graph.json`.
3. `loadGraph(repo: string): Promise<KnowledgeGraph | null>` — Load and deserialize the graph, converting the plain-object back to a `Map` for `entities`. Return `null` (not throw) if no graph exists.
4. `saveRepoSnapshot(snapshot: RepoSnapshot): Promise<void>` — Save snapshot metadata to `af-data/knowledge-graph/{owner}/{repo}/snapshot.json`.
5. `loadRepoSnapshot(repo: string): Promise<RepoSnapshot | null>` — Load snapshot metadata, returning `null` if none exists.
6. `deleteGraph(repo: string): Promise<void>` — Remove both `graph.json` and `snapshot.json` for a repo.
7. The `repo` parameter follows the `{owner}/{repo}` format (e.g., `"jamesstineheath/agent-forge"`).
8. Storage paths follow: `af-data/knowledge-graph/{owner}/{repo}/graph.json` and `af-data/knowledge-graph/{owner}/{repo}/snapshot.json`.
9. Use the existing `lib/storage.ts` `put`/`get`/`del` helpers — do not call Vercel Blob APIs directly.
10. Create `lib/__tests__/knowledge-graph-storage.test.ts` with unit tests that verify:
    - Round-trip serialization of a graph with a populated `entities` Map and relationships array.
    - `loadGraph` returns `null` for a nonexistent repo.
    - `loadRepoSnapshot` returns `null` for a nonexistent repo.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/knowledge-graph-storage-layer
```

### Step 1: Inspect existing types and storage helpers

Read the existing files to understand exact type shapes and helper signatures before writing any code:

```bash
cat lib/knowledge-graph/types.ts
cat lib/storage.ts
```

Key things to confirm:
- The exact shape of `KnowledgeGraph` — particularly the `entities` field type (expected: `Map<string, Entity>`) and `relationships` field type.
- The exact shape of `RepoSnapshot`.
- The signatures of `put`, `get`, and `del` in `lib/storage.ts` (expected: `put(key, value)`, `get(key)`, `del(key)` where key is the blob path).
- Whether `get` returns `null` or throws when a key doesn't exist.

Also check if there's already a `lib/knowledge-graph/` directory:
```bash
ls lib/knowledge-graph/ 2>/dev/null || echo "Directory not found"
```

### Step 2: Implement lib/knowledge-graph/storage.ts

Create `lib/knowledge-graph/storage.ts`. The implementation below is a strong starting point — **adjust type imports and function signatures to match what you found in Step 1**.

```typescript
import { KnowledgeGraph, RepoSnapshot } from './types';
import { put, get, del } from '../storage';

/**
 * Converts a repo string "owner/repo" to storage path segments.
 * e.g. "jamesstineheath/agent-forge" → "jamesstineheath/agent-forge"
 */
function graphPath(repo: string): string {
  return `af-data/knowledge-graph/${repo}/graph.json`;
}

function snapshotPath(repo: string): string {
  return `af-data/knowledge-graph/${repo}/snapshot.json`;
}

/**
 * Serializable form of KnowledgeGraph where the entities Map
 * is converted to a plain object for JSON storage.
 */
interface SerializedKnowledgeGraph extends Omit<KnowledgeGraph, 'entities'> {
  entities: Record<string, unknown>;
}

export async function saveGraph(repo: string, graph: KnowledgeGraph): Promise<void> {
  const serialized: SerializedKnowledgeGraph = {
    ...graph,
    entities: Object.fromEntries(graph.entities),
  };
  await put(graphPath(repo), JSON.stringify(serialized));
}

export async function loadGraph(repo: string): Promise<KnowledgeGraph | null> {
  try {
    const raw = await get(graphPath(repo));
    if (raw === null || raw === undefined) {
      return null;
    }
    const serialized: SerializedKnowledgeGraph = JSON.parse(
      typeof raw === 'string' ? raw : JSON.stringify(raw)
    );
    const graph: KnowledgeGraph = {
      ...serialized,
      entities: new Map(Object.entries(serialized.entities)),
    };
    return graph;
  } catch (err: unknown) {
    // Return null for missing keys (not-found errors)
    if (isNotFoundError(err)) {
      return null;
    }
    throw err;
  }
}

export async function saveRepoSnapshot(snapshot: RepoSnapshot): Promise<void> {
  const repo = snapshot.repo; // adjust field name if different in types.ts
  await put(snapshotPath(repo), JSON.stringify(snapshot));
}

export async function loadRepoSnapshot(repo: string): Promise<RepoSnapshot | null> {
  try {
    const raw = await get(snapshotPath(repo));
    if (raw === null || raw === undefined) {
      return null;
    }
    return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) as RepoSnapshot;
  } catch (err: unknown) {
    if (isNotFoundError(err)) {
      return null;
    }
    throw err;
  }
}

export async function deleteGraph(repo: string): Promise<void> {
  await Promise.all([
    del(graphPath(repo)).catch(() => { /* ignore if already absent */ }),
    del(snapshotPath(repo)).catch(() => { /* ignore if already absent */ }),
  ]);
}

/**
 * Heuristic to detect "key not found" errors from the storage layer.
 * Adjust based on what lib/storage.ts actually throws.
 */
function isNotFoundError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const message = (err as Error).message ?? '';
  return (
    message.includes('not found') ||
    message.includes('404') ||
    message.includes('BlobNotFound') ||
    (err as { status?: number }).status === 404
  );
}
```

> **Important adjustments after reading Step 1:**
> - If `lib/storage.ts` returns `null` directly (no throw) for missing keys, remove the try/catch `isNotFoundError` logic and use the `null` check only.
> - If `RepoSnapshot` uses a different field name for the repo identifier (e.g., `repoFullName` instead of `repo`), update `saveRepoSnapshot` accordingly.
> - If the `entities` Map values have a specific type (e.g., `Map<string, Entity>`), tighten the `SerializedKnowledgeGraph` type to `Record<string, Entity>`.
> - If `put`/`get`/`del` have different signatures (e.g., `get` returns the parsed object, not a string), adjust the `JSON.parse` calls.

### Step 3: Create the test file

Create `lib/__tests__/knowledge-graph-storage.test.ts`:

```typescript
import { saveGraph, loadGraph, saveRepoSnapshot, loadRepoSnapshot, deleteGraph } from '../knowledge-graph/storage';

// Mock lib/storage.ts
jest.mock('../storage', () => {
  const store = new Map<string, string>();
  return {
    put: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    get: jest.fn(async (key: string) => {
      return store.get(key) ?? null;
    }),
    del: jest.fn(async (key: string) => {
      store.delete(key);
    }),
    // Expose store for test assertions if needed
    __store: store,
  };
});

// Import the mock to clear between tests
import * as storage from '../storage';

// Helper to reset the mock store between tests
function resetStore() {
  const mockGet = storage.get as jest.MockedFunction<typeof storage.get>;
  const mockPut = storage.put as jest.MockedFunction<typeof storage.put>;
  const mockDel = storage.del as jest.MockedFunction<typeof storage.del>;
  mockGet.mockClear();
  mockPut.mockClear();
  mockDel.mockClear();
  // Reset the internal store
  (storage as unknown as { __store: Map<string, string> }).__store.clear();
}

const TEST_REPO = 'test-owner/test-repo';

describe('Knowledge Graph Storage', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('saveGraph / loadGraph', () => {
    it('round-trips a graph with a populated entities Map', async () => {
      const mockGraph = {
        repo: TEST_REPO,
        entities: new Map([
          ['entity-1', { id: 'entity-1', name: 'MyClass', type: 'class', filePath: 'src/my-class.ts' }],
          ['entity-2', { id: 'entity-2', name: 'myFunction', type: 'function', filePath: 'src/utils.ts' }],
        ]),
        relationships: [
          { from: 'entity-1', to: 'entity-2', type: 'calls' },
        ],
        indexedAt: new Date().toISOString(),
      } as any; // cast as any to avoid strict type issues with incomplete mock

      await saveGraph(TEST_REPO, mockGraph);
      const loaded = await loadGraph(TEST_REPO);

      expect(loaded).not.toBeNull();
      expect(loaded!.entities).toBeInstanceOf(Map);
      expect(loaded!.entities.size).toBe(2);
      expect(loaded!.entities.get('entity-1')).toMatchObject({ id: 'entity-1', name: 'MyClass' });
      expect(loaded!.entities.get('entity-2')).toMatchObject({ id: 'entity-2', name: 'myFunction' });
      expect(loaded!.relationships).toHaveLength(1);
      expect(loaded!.relationships[0]).toMatchObject({ from: 'entity-1', to: 'entity-2', type: 'calls' });
    });

    it('preserves all graph fields through serialization', async () => {
      const mockGraph = {
        repo: TEST_REPO,
        entities: new Map([
          ['e1', { id: 'e1', name: 'Foo', type: 'class', filePath: 'src/foo.ts' }],
        ]),
        relationships: [],
        indexedAt: '2024-01-01T00:00:00.000Z',
      } as any;

      await saveGraph(TEST_REPO, mockGraph);
      const loaded = await loadGraph(TEST_REPO);

      expect(loaded!.repo).toBe(TEST_REPO);
      expect(loaded!.indexedAt).toBe('2024-01-01T00:00:00.000Z');
      expect(loaded!.relationships).toEqual([]);
    });

    it('returns null for a nonexistent repo', async () => {
      const result = await loadGraph('nonexistent/repo');
      expect(result).toBeNull();
    });

    it('saves to the correct storage path', async () => {
      const mockGraph = {
        repo: TEST_REPO,
        entities: new Map(),
        relationships: [],
        indexedAt: new Date().toISOString(),
      } as any;

      await saveGraph(TEST_REPO, mockGraph);

      const mockPut = storage.put as jest.MockedFunction<typeof storage.put>;
      expect(mockPut).toHaveBeenCalledWith(
        'af-data/knowledge-graph/test-owner/test-repo/graph.json',
        expect.any(String)
      );
    });
  });

  describe('saveRepoSnapshot / loadRepoSnapshot', () => {
    it('round-trips a RepoSnapshot', async () => {
      const snapshot = {
        repo: TEST_REPO,
        lastIndexedAt: '2024-01-15T12:00:00.000Z',
        fileCount: 42,
        commitSha: 'abc123def456',
      } as any;

      await saveRepoSnapshot(snapshot);
      const loaded = await loadRepoSnapshot(TEST_REPO);

      expect(loaded).not.toBeNull();
      expect(loaded!.repo).toBe(TEST_REPO);
      expect(loaded!.lastIndexedAt).toBe('2024-01-15T12:00:00.000Z');
      expect(loaded!.fileCount).toBe(42);
      expect(loaded!.commitSha).toBe('abc123def456');
    });

    it('returns null for a nonexistent repo snapshot', async () => {
      const result = await loadRepoSnapshot('nonexistent/repo');
      expect(result).toBeNull();
    });
  });

  describe('deleteGraph', () => {
    it('removes both graph and snapshot for a repo', async () => {
      const mockGraph = {
        repo: TEST_REPO,
        entities: new Map(),
        relationships: [],
        indexedAt: new Date().toISOString(),
      } as any;
      const snapshot = {
        repo: TEST_REPO,
        lastIndexedAt: new Date().toISOString(),
      } as any;

      await saveGraph(TEST_REPO, mockGraph);
      await saveRepoSnapshot(snapshot);

      // Confirm they exist
      expect(await loadGraph(TEST_REPO)).not.toBeNull();
      expect(await loadRepoSnapshot(TEST_REPO)).not.toBeNull();

      await deleteGraph(TEST_REPO);

      // Confirm they're gone
      expect(await loadGraph(TEST_REPO)).toBeNull();
      expect(await loadRepoSnapshot(TEST_REPO)).toBeNull();
    });

    it('does not throw when deleting a nonexistent repo', async () => {
      await expect(deleteGraph('nonexistent/repo')).resolves.not.toThrow();
    });
  });
});
```

> **Note on mock approach:** The mock above uses a shared in-memory `store` Map that persists across calls within the same `jest.mock` factory. The `beforeEach` calls `resetStore()` which clears both mock call history and the internal store. If the mock approach doesn't compile cleanly due to module typing, use a simpler approach: `jest.fn()` with `.mockResolvedValue(null)` and assert on call arguments explicitly.

### Step 4: Verify the types compile and tests pass

```bash
# Check TypeScript
npx tsc --noEmit

# Run only the new tests first
npx jest lib/__tests__/knowledge-graph-storage.test.ts --no-coverage

# Run full test suite
npm test
```

If TypeScript errors occur on the `entities` Map typing, inspect the exact generic types in `lib/knowledge-graph/types.ts` and adjust the `SerializedKnowledgeGraph` interface accordingly. Common fix: if `Entity` has an index signature, the `Object.fromEntries` and `Object.entries` calls may need explicit type annotations.

If tests fail due to mock structure, simplify the mock:

```typescript
// Simpler mock alternative if the shared-store approach has issues:
const mockStore = new Map<string, string>();

jest.mock('../storage', () => ({
  put: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  get: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  del: jest.fn(async (key: string) => { mockStore.delete(key); }),
}));

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
});
```

### Step 5: Build check

```bash
npm run build
```

### Step 6: Commit, push, open PR

```bash
git add lib/knowledge-graph/storage.ts lib/__tests__/knowledge-graph-storage.test.ts
git commit -m "feat: implement knowledge graph storage layer

- saveGraph/loadGraph with Map serialization via Object.fromEntries/entries
- saveRepoSnapshot/loadRepoSnapshot for indexing metadata  
- deleteGraph removes both graph.json and snapshot.json
- Unit tests verify round-trip serialization and null returns for missing keys
- Storage paths: af-data/knowledge-graph/{owner}/{repo}/{graph,snapshot}.json"

git push origin feat/knowledge-graph-storage-layer

gh pr create \
  --title "feat: implement knowledge graph storage layer" \
  --body "## Summary

Implements the persistence layer for the Knowledge Graph subsystem.

## Changes
- \`lib/knowledge-graph/storage.ts\`: Five exported functions (saveGraph, loadGraph, saveRepoSnapshot, loadRepoSnapshot, deleteGraph) using existing \`lib/storage.ts\` helpers
- \`lib/__tests__/knowledge-graph-storage.test.ts\`: Unit tests verifying round-trip serialization, null returns, and correct storage paths

## Key Design Decisions
- **Map serialization**: \`entities\` Map converted to plain object via \`Object.fromEntries\` on save, restored with \`new Map(Object.entries(...))\` on load
- **Null-safe loading**: loadGraph/loadRepoSnapshot return null (not throw) for missing keys
- **deleteGraph**: Removes both graph.json and snapshot.json in parallel; silently ignores already-absent keys

## Storage Paths
- \`af-data/knowledge-graph/{owner}/{repo}/graph.json\`
- \`af-data/knowledge-graph/{owner}/{repo}/snapshot.json\`

## Testing
All acceptance criteria covered by unit tests with mocked storage layer."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
```bash
git add -A
git commit -m "wip: knowledge graph storage layer (partial)"
git push origin feat/knowledge-graph-storage-layer
gh pr create --title "wip: knowledge graph storage layer" --body "Partial implementation — see ISSUES below"
```

2. Output structured report:
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/knowledge-graph-storage-layer
FILES CHANGED: [lib/knowledge-graph/storage.ts, lib/__tests__/knowledge-graph-storage.test.ts]
SUMMARY: [what was implemented]
ISSUES: [what failed or is incomplete]
NEXT STEPS: [e.g., "Fix Map deserialization type error on line 42", "Add deleteGraph tests"]
```

3. If blocked by an architectural ambiguity (e.g., `lib/storage.ts` has a fundamentally different API than expected, or `KnowledgeGraph` types don't exist yet):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "implement-knowledge-graph-storage-layer",
    "reason": "lib/knowledge-graph/types.ts does not exist or has unexpected shape preventing storage implementation",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "Step 1",
      "error": "<paste actual error>",
      "filesChanged": []
    }
  }'
```