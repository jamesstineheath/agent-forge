# Agent Forge -- Define Plan Cache Types and Storage Schema

## Metadata
- **Branch:** `feat/plan-cache-types-and-storage`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/plan-cache/types.ts, lib/plan-cache/storage.ts

## Context

Agent Forge is a dev orchestration platform built on Next.js. It coordinates autonomous agent teams across multiple repositories. A new plan caching system is being introduced to allow the orchestrator to reuse successful work item decomposition patterns across similar projects.

This task creates the foundational layer: the TypeScript types and Vercel Blob storage utilities for plan templates. Subsequent tasks will build matching/similarity logic and integration with the decomposer on top of these foundations.

**Existing storage patterns to follow:**

`lib/storage.ts` uses Vercel Blob with auth headers and JSON serialization. Example pattern:
```typescript
import { put, get, list, del } from '@vercel/blob';

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

export async function saveX(x: X): Promise<void> {
  await put(`af-data/x/${x.id}.json`, JSON.stringify(x), {
    access: 'public',
    token: BLOB_TOKEN,
    addRandomSuffix: false,
  });
}

export async function getX(id: string): Promise<X | null> {
  try {
    const { blobs } = await list({ prefix: `af-data/x/${id}.json`, token: BLOB_TOKEN });
    if (!blobs.length) return null;
    const res = await fetch(blobs[0].url);
    return await res.json() as X;
  } catch {
    return null;
  }
}
```

`lib/work-items.ts` demonstrates the index pattern — a separate lightweight blob listing all items for fast lookup without loading full records.

**Key design decisions per spec:**
- Templates are project-agnostic: concrete repo names, branch names, PR numbers are stripped
- Each `CachedStep` maps to a work item shape with parameterizable placeholders
- `PlanCacheIndex` is a lightweight separate blob for fast similarity search

## Requirements

1. Create `lib/plan-cache/types.ts` exporting `PlanTemplate`, `PlanMatch`, `PlanCacheIndex`, and `CachedStep` interfaces with all documented fields
2. `PlanTemplate` must include: `id`, `sourceProjectId`, `sourceWorkItems` (array), `templateSteps` (array of `CachedStep` with dependency DAG), metadata fields (`domainTags`, `complexity`, `filePatterns`, `createdAt`), and usage tracking fields: `usageCount` (number), `lastUsedAt` (string), `performanceStats` (object with `avgExecutionTime`, `successRate`)
3. `CachedStep` must include: `title`, `description`, `filePatterns`, `complexity`, `acceptanceCriteria`, `dependencyRefs`
4. `PlanMatch` must include: `templateId`, `similarityScore`, `matchedFeatures`
5. `PlanCacheIndex` is an array of lightweight index entries (not full templates) for fast lookup
6. Create `lib/plan-cache/storage.ts` exporting: `savePlanTemplate`, `getPlanTemplate`, `listPlanTemplates`, `updatePlanTemplate`, `deletePlanTemplate`, `getPlanCacheIndex`, `updatePlanCacheIndex`
7. Storage functions use Vercel Blob paths: `af-data/plan-cache/templates/{id}.json` and `af-data/plan-cache/index.json`
8. Storage functions follow existing patterns in `lib/storage.ts` (auth headers via `BLOB_READ_WRITE_TOKEN`, JSON serialization, `addRandomSuffix: false`)
9. `TypeScript compiles without errors (`npx tsc --noEmit` passes)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/plan-cache-types-and-storage
```

### Step 1: Review existing storage patterns
Read the existing storage files to understand the exact patterns used:
```bash
cat lib/storage.ts
cat lib/work-items.ts
```
Note the exact import paths for `@vercel/blob`, how the token is accessed, error handling patterns, and how the index is maintained in `work-items.ts`.

### Step 2: Create the plan-cache directory and types file

Create `lib/plan-cache/types.ts`:

```typescript
// lib/plan-cache/types.ts

/**
 * A single parameterized step in a plan template.
 * Maps to a work item shape but with project-agnostic placeholders
 * (no concrete repo names, branch names, or PR numbers).
 */
export interface CachedStep {
  /** Human-readable title, may contain {{placeholder}} tokens */
  title: string;
  /** Detailed description of what this step accomplishes */
  description: string;
  /** Glob patterns for files typically created or modified in this step */
  filePatterns: string[];
  /** Estimated complexity: low | medium | high */
  complexity: 'low' | 'medium' | 'high';
  /** Testable acceptance criteria for this step */
  acceptanceCriteria: string[];
  /** Step IDs within this template that this step depends on */
  dependencyRefs: string[];
  /** Stable ID for this step within the template */
  id: string;
}

/**
 * Performance statistics for a plan template based on historical executions.
 */
export interface PlanTemplatePerformanceStats {
  /** Average execution time in milliseconds across all uses */
  avgExecutionTime: number;
  /** Fraction of uses that resulted in a merged PR (0.0–1.0) */
  successRate: number;
}

/**
 * A project-agnostic plan template derived from a successfully executed project.
 * Concrete identifiers (repo names, branch names, PR numbers) are stripped.
 */
export interface PlanTemplate {
  /** Unique identifier for this template (e.g., UUID or slug) */
  id: string;
  /** The Notion project ID this template was derived from */
  sourceProjectId: string;
  /** Lightweight references to the original work items (IDs only, for traceability) */
  sourceWorkItems: string[];
  /** The parameterized steps forming the plan, with dependency DAG via dependencyRefs */
  templateSteps: CachedStep[];
  /** Domain tags for similarity matching (e.g., ["auth", "nextjs", "api"]) */
  domainTags: string[];
  /** Overall complexity of this plan template */
  complexity: 'low' | 'medium' | 'high';
  /** Aggregate file patterns across all steps, for quick index-level matching */
  filePatterns: string[];
  /** ISO 8601 timestamp when this template was created */
  createdAt: string;
  /** ISO 8601 timestamp when this template was last used */
  lastUsedAt: string;
  /** Number of times this template has been used */
  usageCount: number;
  /** Aggregated performance data from historical uses */
  performanceStats: PlanTemplatePerformanceStats;
}

/**
 * Result of matching an incoming project description against a plan template.
 */
export interface PlanMatch {
  /** ID of the matched template */
  templateId: string;
  /** Similarity score between 0.0 and 1.0 */
  similarityScore: number;
  /** Human-readable feature names that contributed to the match */
  matchedFeatures: string[];
}

/**
 * A lightweight index entry for a plan template.
 * Stored in the index blob for fast lookup without loading full template blobs.
 */
export interface PlanCacheIndexEntry {
  id: string;
  domainTags: string[];
  complexity: 'low' | 'medium' | 'high';
  filePatterns: string[];
  stepCount: number;
  usageCount: number;
  successRate: number;
  createdAt: string;
  lastUsedAt: string;
}

/**
 * The full plan cache index: an array of lightweight entries.
 * Stored at af-data/plan-cache/index.json.
 */
export type PlanCacheIndex = PlanCacheIndexEntry[];
```

### Step 3: Create the storage file

Create `lib/plan-cache/storage.ts`. First confirm the exact `@vercel/blob` API used in `lib/storage.ts` (some versions use `head`, `list`, direct URL fetch, etc.), then implement:

```typescript
// lib/plan-cache/storage.ts

import { put, list, del } from '@vercel/blob';
import type { PlanTemplate, PlanCacheIndex, PlanCacheIndexEntry } from './types';

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

const TEMPLATE_PREFIX = 'af-data/plan-cache/templates/';
const INDEX_PATH = 'af-data/plan-cache/index.json';

// ─── Template CRUD ────────────────────────────────────────────────────────────

/**
 * Persist a plan template to Vercel Blob.
 * Also upserts the index entry.
 */
export async function savePlanTemplate(template: PlanTemplate): Promise<void> {
  await put(
    `${TEMPLATE_PREFIX}${template.id}.json`,
    JSON.stringify(template),
    {
      access: 'public',
      token: BLOB_TOKEN,
      addRandomSuffix: false,
    }
  );

  // Keep index in sync
  const index = await getPlanCacheIndex();
  const entry = templateToIndexEntry(template);
  const existing = index.findIndex((e) => e.id === template.id);
  if (existing >= 0) {
    index[existing] = entry;
  } else {
    index.push(entry);
  }
  await updatePlanCacheIndex(index);
}

/**
 * Retrieve a plan template by ID. Returns null if not found.
 */
export async function getPlanTemplate(id: string): Promise<PlanTemplate | null> {
  try {
    const { blobs } = await list({
      prefix: `${TEMPLATE_PREFIX}${id}.json`,
      token: BLOB_TOKEN,
    });
    if (!blobs.length) return null;
    const res = await fetch(blobs[0].url);
    if (!res.ok) return null;
    return (await res.json()) as PlanTemplate;
  } catch {
    return null;
  }
}

/**
 * List all plan templates. Loads each template blob individually.
 * For large caches, prefer using getPlanCacheIndex() for lightweight listing.
 */
export async function listPlanTemplates(): Promise<PlanTemplate[]> {
  try {
    const { blobs } = await list({
      prefix: TEMPLATE_PREFIX,
      token: BLOB_TOKEN,
    });
    const templates = await Promise.all(
      blobs.map(async (blob) => {
        try {
          const res = await fetch(blob.url);
          if (!res.ok) return null;
          return (await res.json()) as PlanTemplate;
        } catch {
          return null;
        }
      })
    );
    return templates.filter((t): t is PlanTemplate => t !== null);
  } catch {
    return [];
  }
}

/**
 * Apply a partial update to an existing plan template.
 * No-ops if the template does not exist.
 */
export async function updatePlanTemplate(
  id: string,
  partial: Partial<PlanTemplate>
): Promise<void> {
  const existing = await getPlanTemplate(id);
  if (!existing) return;
  const updated: PlanTemplate = { ...existing, ...partial, id };
  await savePlanTemplate(updated);
}

/**
 * Delete a plan template and remove it from the index.
 */
export async function deletePlanTemplate(id: string): Promise<void> {
  try {
    const { blobs } = await list({
      prefix: `${TEMPLATE_PREFIX}${id}.json`,
      token: BLOB_TOKEN,
    });
    if (blobs.length) {
      await del(blobs[0].url, { token: BLOB_TOKEN });
    }
  } catch {
    // Blob may already be absent; continue to clean up index
  }

  const index = await getPlanCacheIndex();
  const filtered = index.filter((e) => e.id !== id);
  await updatePlanCacheIndex(filtered);
}

// ─── Index CRUD ───────────────────────────────────────────────────────────────

/**
 * Retrieve the plan cache index. Returns empty array if not yet created.
 */
export async function getPlanCacheIndex(): Promise<PlanCacheIndex> {
  try {
    const { blobs } = await list({
      prefix: INDEX_PATH,
      token: BLOB_TOKEN,
    });
    if (!blobs.length) return [];
    const res = await fetch(blobs[0].url);
    if (!res.ok) return [];
    return (await res.json()) as PlanCacheIndex;
  } catch {
    return [];
  }
}

/**
 * Overwrite the plan cache index blob with the provided array.
 */
export async function updatePlanCacheIndex(index: PlanCacheIndex): Promise<void> {
  await put(INDEX_PATH, JSON.stringify(index), {
    access: 'public',
    token: BLOB_TOKEN,
    addRandomSuffix: false,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function templateToIndexEntry(template: PlanTemplate): PlanCacheIndexEntry {
  return {
    id: template.id,
    domainTags: template.domainTags,
    complexity: template.complexity,
    filePatterns: template.filePatterns,
    stepCount: template.templateSteps.length,
    usageCount: template.usageCount,
    successRate: template.performanceStats.successRate,
    createdAt: template.createdAt,
    lastUsedAt: template.lastUsedAt,
  };
}
```

> **Important:** After writing the initial files, run `npx tsc --noEmit` and fix any type errors before continuing. Pay attention to:
> - Whether `del` from `@vercel/blob` accepts a URL string or an object — check existing usage in `lib/storage.ts`
> - Whether `list` returns `{ blobs }` or a different shape — confirm against existing usage
> - Any missing `PlanCacheIndexEntry` export (it must be exported from `types.ts`)

### Step 4: Verify no TypeScript errors

```bash
npx tsc --noEmit
```

Fix any errors. Common issues:
- `del` signature differences across `@vercel/blob` versions — check `node_modules/@vercel/blob/dist/index.d.ts` or look at how `lib/storage.ts` calls it
- Missing exports — ensure `PlanCacheIndexEntry` is exported from `types.ts`
- Implicit `any` — add explicit types where needed

### Step 5: Verify build passes

```bash
npm run build
```

If build fails for unrelated reasons (pre-existing issues), note them but do not block on them — this task only adds new files and should not break existing compilation.

### Step 6: Commit, push, open PR

```bash
git add lib/plan-cache/types.ts lib/plan-cache/storage.ts
git commit -m "feat: define plan cache types and storage schema

- Add lib/plan-cache/types.ts with PlanTemplate, CachedStep, PlanMatch,
  PlanCacheIndex, and PlanCacheIndexEntry interfaces
- Add lib/plan-cache/storage.ts with full CRUD for templates and index
- Storage uses Vercel Blob at af-data/plan-cache/ following existing patterns
- Index is a separate lightweight blob for fast similarity search"

git push origin feat/plan-cache-types-and-storage

gh pr create \
  --title "feat: define plan cache types and storage schema" \
  --body "## Summary

Creates the foundational types and Vercel Blob storage utilities for the plan caching system.

## Changes

### \`lib/plan-cache/types.ts\`
- \`CachedStep\` — parameterized work item step with \`dependencyRefs\` for DAG
- \`PlanTemplate\` — project-agnostic template with metadata, usage tracking (\`usageCount\`, \`lastUsedAt\`), and \`performanceStats\` (\`avgExecutionTime\`, \`successRate\`)
- \`PlanMatch\` — similarity match result with \`templateId\`, \`similarityScore\`, \`matchedFeatures\`
- \`PlanCacheIndex\` / \`PlanCacheIndexEntry\` — lightweight index type for fast lookup

### \`lib/plan-cache/storage.ts\`
- \`savePlanTemplate\` / \`getPlanTemplate\` / \`listPlanTemplates\` / \`updatePlanTemplate\` / \`deletePlanTemplate\`
- \`getPlanCacheIndex\` / \`updatePlanCacheIndex\`
- Blob paths: \`af-data/plan-cache/templates/{id}.json\` and \`af-data/plan-cache/index.json\`
- Follows existing \`lib/storage.ts\` patterns (auth headers, JSON, \`addRandomSuffix: false\`)

## Acceptance Criteria
- [x] All required types exported from \`lib/plan-cache/types.ts\`
- [x] All required storage functions exported from \`lib/plan-cache/storage.ts\`
- [x] Blob paths under \`af-data/plan-cache/\`
- [x] \`npx tsc --noEmit\` passes
- [x] \`PlanTemplate\` includes \`usageCount\`, \`lastUsedAt\`, \`performanceStats\`"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/plan-cache-types-and-storage
FILES CHANGED: [lib/plan-cache/types.ts, lib/plan-cache/storage.ts]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If blocked on an unresolvable issue (e.g., `@vercel/blob` API incompatibility, missing environment setup, architectural ambiguity), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "plan-cache-types-and-storage",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message>",
      "filesChanged": ["lib/plan-cache/types.ts", "lib/plan-cache/storage.ts"]
    }
  }'
```