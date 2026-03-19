# Agent Forge -- Create TLM memory migration script and compatibility adapter

## Metadata
- **Branch:** `feat/tlm-memory-migration-compat-adapter`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** scripts/migrate-tlm-memory.ts, lib/episode-compat.ts, lib/episode-recorder.ts, app/api/agents/tlm-memory/route.ts

## Context

Agent Forge has a TLM (Team Lead Memory) system that currently stores review patterns, outcomes, and lessons in `docs/tlm-memory.md` in target repos. There is an ongoing effort to introduce a more structured `Episode` store backed by Vercel Blob (`BlobEpisodeStore`), replacing the flat markdown file format.

This task creates the bridge layer:
1. A **migration script** (`scripts/migrate-tlm-memory.ts`) that reads existing `tlm-memory.md` entries and populates the Episode store.
2. A **compatibility adapter** (`lib/episode-compat.ts`) that can parse the legacy markdown format and regenerate it from structured Episode records.
3. Updates to **`lib/episode-recorder.ts`** so that recording a new episode automatically regenerates the `tlm-memory.md` compatibility file.
4. Updates to **`app/api/agents/tlm-memory/route.ts`** so the GET endpoint reads from the Episode store (via `syncMemoryWindow`) while maintaining the same response shape.

### Key existing patterns to be aware of:
- `lib/storage.ts` wraps Vercel Blob CRUD — use it for Blob reads/writes.
- `lib/github.ts` wraps the GitHub API — use it for reading files from target repos.
- TLM memory is currently stored in-repo at `docs/tlm-memory.md` in each target repo; the API route reads it via GitHub API or Blob.
- `BlobEpisodeStore` and `Episode` types may already exist (check `lib/episode-store.ts` or similar). If they do not yet exist, define minimal interfaces in `lib/episode-compat.ts` that match what `lib/episode-recorder.ts` uses, and leave TODOs.

### Concurrent work to avoid:
- Branch `fix/create-episodes-api-route-get-apiepisodes` is modifying `app/api/episodes/route.ts` and `app/api/episodes/[id]/route.ts`. **Do not touch those files.**

## Requirements

1. `scripts/migrate-tlm-memory.ts` reads `docs/tlm-memory.md` (from local file path or GitHub API) and parses entries into `LegacyMemoryEntry[]`.
2. Each parsed entry is converted into an Episode record and saved via `BlobEpisodeStore.save()`.
3. Migration is idempotent: a SHA-256 (or similar) content hash is computed per entry; entries with a matching hash already in the store are skipped.
4. Migration script prints a summary (total found, migrated, skipped).
5. `lib/episode-compat.ts` exports:
   - `LegacyMemoryEntry` interface: `{ type: 'hot_pattern' | 'outcome' | 'lesson', description: string, date?: string, details?: string }`
   - `parseTlmMemory(markdown: string): LegacyMemoryEntry[]`
   - `syncMemoryWindow(store: BlobEpisodeStore): Promise<string>` — returns the 20 most recent episodes rendered as `tlm-memory.md` markdown.
   - `renderEpisodeAsMemoryEntry(episode: Episode): string`
6. `lib/episode-recorder.ts` calls `syncMemoryWindow()` after saving an episode and writes the result to the appropriate Blob key (matching current `tlm-memory.md` storage pattern).
7. `GET /api/agents/tlm-memory` reads from `syncMemoryWindow()` instead of directly from `tlm-memory.md`, maintaining the same response shape.
8. Project compiles with `npx tsc --noEmit` (no new type errors introduced).
9. Migration script is runnable with `npx tsx scripts/migrate-tlm-memory.ts`.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/tlm-memory-migration-compat-adapter
```

### Step 1: Explore existing codebase

Before writing any code, read the relevant existing files to understand actual types and APIs in use:

```bash
# Check for existing episode-related files
find . -name "episode*" -not -path "*/node_modules/*" -not -path "*/.git/*"
find . -name "*.ts" | xargs grep -l "BlobEpisodeStore\|Episode" 2>/dev/null | grep -v node_modules | grep -v ".git"

# Read the current tlm-memory API route
cat app/api/agents/tlm-memory/route.ts

# Read the current tlm-memory.md format (if present in repo)
cat docs/tlm-memory.md 2>/dev/null || echo "Not present locally"

# Read storage.ts to understand Blob patterns
cat lib/storage.ts

# Read github.ts for file-fetching patterns  
cat lib/github.ts

# Check existing types
cat lib/types.ts

# Check if episode-recorder already exists
cat lib/episode-recorder.ts 2>/dev/null || echo "Does not exist yet"
```

Document what you find. Adjust all subsequent steps to match actual existing interfaces.

### Step 2: Create `lib/episode-compat.ts`

Create this file. Adjust the `Episode` and `BlobEpisodeStore` interfaces to match whatever already exists in the codebase (from Step 1). If they don't exist yet, define them as minimal forward-compatible interfaces with a TODO comment.

```typescript
// lib/episode-compat.ts
import crypto from 'crypto';

// ── Legacy format types ──────────────────────────────────────────────────────

export interface LegacyMemoryEntry {
  type: 'hot_pattern' | 'outcome' | 'lesson';
  description: string;
  date?: string;
  details?: string;
}

// ── Episode types (adjust to match lib/episode-store.ts or lib/types.ts) ────

export type EpisodeOutcome = 'success' | 'failure' | 'partial';

export interface Episode {
  id: string;
  taskDescription: string;
  approach: string;
  outcome: EpisodeOutcome;
  insights: string[];
  contentHash?: string;   // SHA-256 of source content, for idempotency
  timestamp: string;      // ISO 8601
  sourceType?: 'hot_pattern' | 'outcome' | 'lesson' | 'live';
}

// ── BlobEpisodeStore interface (adjust to match actual implementation) ────────

export interface BlobEpisodeStore {
  save(episode: Episode): Promise<void>;
  list(limit?: number): Promise<Episode[]>;
  findByHash(hash: string): Promise<Episode | null>;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parses a tlm-memory.md markdown string into structured LegacyMemoryEntry records.
 *
 * Expected sections (flexible — adapts to actual format found):
 *   ## Hot Patterns / ## Recent Outcomes / ## Lessons Learned
 *   Each entry is a bullet or numbered list item.
 */
export function parseTlmMemory(markdown: string): LegacyMemoryEntry[] {
  const entries: LegacyMemoryEntry[] = [];

  const sectionRegex = /^##\s+(.+)$/gm;
  const sections: Array<{ title: string; start: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = sectionRegex.exec(markdown)) !== null) {
    sections.push({ title: match[1].trim(), start: match.index });
  }

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const end = i + 1 < sections.length ? sections[i + 1].start : markdown.length;
    const body = markdown.slice(section.start, end);

    const type = classifySectionType(section.title);
    if (!type) continue;

    // Extract bullet/numbered list items
    const itemRegex = /^[-*•]|\d+\.\s/m;
    const lines = body.split('\n');
    let currentEntry: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('##')) {
        if (currentEntry.length > 0) {
          entries.push(buildEntry(type, currentEntry));
          currentEntry = [];
        }
        continue;
      }
      if (itemRegex.test(trimmed)) {
        if (currentEntry.length > 0) {
          entries.push(buildEntry(type, currentEntry));
          currentEntry = [];
        }
        currentEntry.push(trimmed.replace(/^[-*•\d.]\s*/, ''));
      } else if (currentEntry.length > 0) {
        // Continuation line
        currentEntry.push(trimmed);
      }
    }
    if (currentEntry.length > 0) {
      entries.push(buildEntry(type, currentEntry));
    }
  }

  return entries;
}

function classifySectionType(title: string): LegacyMemoryEntry['type'] | null {
  const t = title.toLowerCase();
  if (t.includes('pattern')) return 'hot_pattern';
  if (t.includes('outcome') || t.includes('result')) return 'outcome';
  if (t.includes('lesson') || t.includes('learn')) return 'lesson';
  return null;
}

function buildEntry(type: LegacyMemoryEntry['type'], lines: string[]): LegacyMemoryEntry {
  const [first, ...rest] = lines;
  // Try to extract a date like (2024-01-15) from the description
  const dateMatch = first.match(/\((\d{4}-\d{2}-\d{2}[^)]*)\)/);
  return {
    type,
    description: first.replace(/\s*\([^)]*\)\s*$/, '').trim(),
    date: dateMatch?.[1],
    details: rest.join(' ').trim() || undefined,
  };
}

// ── Outcome mapping ──────────────────────────────────────────────────────────

export function mapOutcome(entry: LegacyMemoryEntry): EpisodeOutcome {
  const combined = `${entry.description} ${entry.details ?? ''}`.toLowerCase();
  if (
    combined.includes('reversed') ||
    combined.includes('caused issues') ||
    combined.includes('broke') ||
    combined.includes('failure') ||
    combined.includes('failed') ||
    combined.includes('incorrect')
  ) {
    return 'failure';
  }
  if (
    combined.includes('missed') ||
    combined.includes('partial') ||
    combined.includes('premature') ||
    combined.includes('incomplete')
  ) {
    return 'partial';
  }
  return 'success';
}

// ── Content hash ─────────────────────────────────────────────────────────────

export function contentHash(entry: LegacyMemoryEntry): string {
  const payload = JSON.stringify({ type: entry.type, description: entry.description, details: entry.details ?? '' });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

// ── Legacy entry → Episode conversion ────────────────────────────────────────

export function legacyEntryToEpisode(entry: LegacyMemoryEntry): Episode {
  const hash = contentHash(entry);
  return {
    id: `migrated-${hash}`,
    taskDescription: entry.description,
    approach: entry.details ?? entry.description,
    outcome: mapOutcome(entry),
    insights: entry.details ? [entry.details] : [],
    contentHash: hash,
    timestamp: entry.date ? new Date(entry.date).toISOString() : new Date(0).toISOString(),
    sourceType: entry.type,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Renders a single Episode in the legacy tlm-memory.md bullet style.
 */
export function renderEpisodeAsMemoryEntry(episode: Episode): string {
  const dateStr = episode.timestamp && episode.timestamp !== new Date(0).toISOString()
    ? ` (${episode.timestamp.slice(0, 10)})`
    : '';
  const outcomeLabel =
    episode.outcome === 'success' ? '✅' :
    episode.outcome === 'failure' ? '❌' : '⚠️';
  const insightStr = episode.insights.length > 0
    ? `\n  - ${episode.insights.join('\n  - ')}`
    : '';
  return `- ${outcomeLabel} ${episode.taskDescription}${dateStr}${insightStr}`;
}

/**
 * Reads the 20 most recent episodes from the store and renders them as a
 * tlm-memory.md compatible markdown string.
 */
export async function syncMemoryWindow(store: BlobEpisodeStore): Promise<string> {
  const episodes = await store.list(20);

  const hotPatterns = episodes.filter(e => e.sourceType === 'hot_pattern' || e.sourceType === 'live');
  const outcomes = episodes.filter(e => e.sourceType === 'outcome');
  const lessons = episodes.filter(e => e.sourceType === 'lesson');

  // If no sourceType segregation, put all in outcomes
  const allFallback = hotPatterns.length === 0 && outcomes.length === 0 && lessons.length === 0
    ? episodes : [];

  const lines: string[] = [
    '# TLM Memory',
    '',
    `> Auto-generated from episode store. Last synced: ${new Date().toISOString()}`,
    '',
  ];

  const renderSection = (title: string, items: Episode[]) => {
    if (items.length === 0) return;
    lines.push(`## ${title}`, '');
    for (const ep of items) {
      lines.push(renderEpisodeAsMemoryEntry(ep));
    }
    lines.push('');
  };

  if (allFallback.length > 0) {
    renderSection('Recent Outcomes', allFallback);
  } else {
    renderSection('Hot Patterns', hotPatterns);
    renderSection('Recent Outcomes', outcomes);
    renderSection('Lessons Learned', lessons);
  }

  return lines.join('\n');
}
```

### Step 3: Create `scripts/migrate-tlm-memory.ts`

```typescript
#!/usr/bin/env node
// scripts/migrate-tlm-memory.ts
//
// Migrates docs/tlm-memory.md entries into the BlobEpisodeStore.
// Usage:
//   npx tsx scripts/migrate-tlm-memory.ts [--file path/to/tlm-memory.md]
//   npx tsx scripts/migrate-tlm-memory.ts [--repo owner/name]
//
// Requires environment: BLOB_READ_WRITE_TOKEN, GH_PAT (if --repo)

import fs from 'fs';
import path from 'path';
import { parseTlmMemory, legacyEntryToEpisode, contentHash, BlobEpisodeStore, Episode } from '../lib/episode-compat';

// ── Minimal BlobEpisodeStore implementation for migration ───────────────────
// Replace with import from lib/episode-store.ts if it exists.

async function createStore(): Promise<BlobEpisodeStore> {
  // Try to import BlobEpisodeStore from the codebase
  // If lib/episode-store.ts exists, use it; otherwise use inline Blob implementation
  try {
    // Attempt dynamic import of actual store
    const mod = await import('../lib/episode-store');
    if (mod.BlobEpisodeStore) {
      return new mod.BlobEpisodeStore();
    }
  } catch {
    // Fall through to inline implementation
  }

  // Inline fallback using lib/storage.ts patterns
  const { put, list: blobList, get } = await import('../lib/storage');

  const PREFIX = 'af-data/episodes/';

  return {
    async save(episode: Episode): Promise<void> {
      const key = `${PREFIX}${episode.id}.json`;
      await put(key, JSON.stringify(episode), { contentType: 'application/json' });
    },
    async list(limit = 20): Promise<Episode[]> {
      const blobs = await blobList(PREFIX);
      const items: Episode[] = [];
      // Sort descending by name (ISO timestamps sort lexicographically)
      const sorted = (blobs.blobs ?? [])
        .sort((a: { pathname: string }, b: { pathname: string }) => b.pathname.localeCompare(a.pathname))
        .slice(0, limit);
      for (const blob of sorted) {
        try {
          const raw = await get(blob.pathname);
          if (raw) items.push(JSON.parse(raw) as Episode);
        } catch { /* skip corrupt entries */ }
      }
      return items;
    },
    async findByHash(hash: string): Promise<Episode | null> {
      const blobs = await blobList(PREFIX);
      for (const blob of (blobs.blobs ?? [])) {
        try {
          const raw = await get(blob.pathname);
          if (raw) {
            const ep = JSON.parse(raw) as Episode;
            if (ep.contentHash === hash) return ep;
          }
        } catch { /* skip */ }
      }
      return null;
    },
  };
}

// ── Source reading ───────────────────────────────────────────────────────────

async function readMarkdown(options: { file?: string; repo?: string }): Promise<string> {
  if (options.file) {
    return fs.readFileSync(path.resolve(options.file), 'utf-8');
  }
  if (options.repo) {
    // Read via GitHub API
    const { getFileContent } = await import('../lib/github');
    const [owner, repo] = options.repo.split('/');
    const content = await getFileContent(owner, repo, 'docs/tlm-memory.md');
    if (!content) throw new Error(`docs/tlm-memory.md not found in ${options.repo}`);
    return content;
  }
  // Default: local file
  const localPath = path.resolve('docs/tlm-memory.md');
  if (fs.existsSync(localPath)) {
    return fs.readFileSync(localPath, 'utf-8');
  }
  throw new Error('No source specified. Use --file or --repo, or ensure docs/tlm-memory.md exists locally.');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const repoIdx = args.indexOf('--repo');

  const opts = {
    file: fileIdx >= 0 ? args[fileIdx + 1] : undefined,
    repo: repoIdx >= 0 ? args[repoIdx + 1] : undefined,
  };

  console.log('📖 Reading tlm-memory.md...');
  const markdown = await readMarkdown(opts);
  console.log(`   ${markdown.length} characters read.`);

  console.log('🔍 Parsing entries...');
  const entries = parseTlmMemory(markdown);
  console.log(`   Found ${entries.length} entries (${entries.filter(e => e.type === 'hot_pattern').length} hot_pattern, ${entries.filter(e => e.type === 'outcome').length} outcome, ${entries.filter(e => e.type === 'lesson').length} lesson).`);

  if (entries.length === 0) {
    console.log('⚠️  No entries parsed. Check that docs/tlm-memory.md has ## Hot Patterns / ## Recent Outcomes / ## Lessons sections.');
    process.exit(0);
  }

  console.log('🔌 Connecting to episode store...');
  const store = await createStore();

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    const hash = contentHash(entry);
    try {
      const existing = await store.findByHash(hash);
      if (existing) {
        skipped++;
        continue;
      }
      const episode = legacyEntryToEpisode(entry);
      await store.save(episode);
      migrated++;
      console.log(`   ✅ Migrated: ${entry.description.slice(0, 60)}...`);
    } catch (err) {
      failed++;
      console.error(`   ❌ Failed for "${entry.description.slice(0, 40)}...":`, err);
    }
  }

  console.log('\n📊 Migration summary:');
  console.log(`   Total entries:  ${entries.length}`);
  console.log(`   Migrated:       ${migrated}`);
  console.log(`   Skipped:        ${skipped} (already exist)`);
  console.log(`   Failed:         ${failed}`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
```

### Step 4: Inspect and update `lib/episode-recorder.ts`

First, check if the file exists and read it:
```bash
cat lib/episode-recorder.ts 2>/dev/null || echo "FILE_DOES_NOT_EXIST"
```

**If the file exists:** Add the `syncMemoryWindow` call after a successful `save()`. Find the `save`/`record` function and append:

```typescript
// After store.save(episode) call, regenerate tlm-memory.md compat file
import { syncMemoryWindow } from './episode-compat';
import { put } from './storage';

// Inside the record/save function, after saving:
try {
  const memoryMarkdown = await syncMemoryWindow(store);
  await put('af-data/tlm-memory-compat.md', memoryMarkdown, { contentType: 'text/markdown' });
} catch (err) {
  // Non-fatal: log but don't fail the episode recording
  console.error('[episode-recorder] Failed to sync memory window:', err);
}
```

**If the file does NOT exist:** Create a minimal `lib/episode-recorder.ts`:

```typescript
// lib/episode-recorder.ts
import { Episode, BlobEpisodeStore } from './episode-compat';
import { syncMemoryWindow } from './episode-compat';
import { put } from './storage';

export const MEMORY_COMPAT_BLOB_KEY = 'af-data/tlm-memory-compat.md';

/**
 * Records an episode and regenerates the tlm-memory.md compatibility file.
 */
export async function recordEpisode(store: BlobEpisodeStore, episode: Episode): Promise<void> {
  await store.save(episode);

  // Regenerate compatibility file — non-fatal
  try {
    const memoryMarkdown = await syncMemoryWindow(store);
    await put(MEMORY_COMPAT_BLOB_KEY, memoryMarkdown, { contentType: 'text/markdown' });
  } catch (err) {
    console.error('[episode-recorder] Failed to sync memory window:', err);
  }
}
```

### Step 5: Update `app/api/agents/tlm-memory/route.ts`

First read the existing file:
```bash
cat app/api/agents/tlm-memory/route.ts
```

The goal is to:
1. Keep the same response shape.
2. Attempt to read from the episode store / compat Blob key first.
3. Fall back to the existing logic if the episode store is empty or unavailable.

The update pattern (adapt to actual existing code):

```typescript
// app/api/agents/tlm-memory/route.ts
// ... existing imports ...
import { syncMemoryWindow, BlobEpisodeStore } from '@/lib/episode-compat';
import { MEMORY_COMPAT_BLOB_KEY } from '@/lib/episode-recorder';
import { get as blobGet } from '@/lib/storage';

// Inside the GET handler, replace the tlm-memory.md read with:
async function getTlmMemoryMarkdown(): Promise<string | null> {
  // 1. Try the episode-store-backed compat blob
  try {
    const cached = await blobGet(MEMORY_COMPAT_BLOB_KEY);
    if (cached && cached.trim().length > 0) {
      return cached;
    }
  } catch { /* fall through */ }

  // 2. Try live sync from episode store (if store is available)
  try {
    // Attempt to instantiate the real BlobEpisodeStore
    // Adjust import path if lib/episode-store.ts exists
    let store: BlobEpisodeStore | null = null;
    try {
      const mod = await import('@/lib/episode-store');
      store = new mod.BlobEpisodeStore();
    } catch { /* store module not available */ }

    if (store) {
      const episodes = await store.list(20);
      if (episodes.length > 0) {
        return await syncMemoryWindow(store);
      }
    }
  } catch { /* fall through to legacy */ }

  // 3. Fall back to existing legacy source (GitHub API or wherever it was read before)
  return null;
}

// In the GET handler:
export async function GET(request: Request) {
  // ... existing auth check ...

  const episodeMarkdown = await getTlmMemoryMarkdown();
  if (episodeMarkdown) {
    // Return in same shape as existing response
    // Examine the existing response structure and match it exactly
    return Response.json({ markdown: episodeMarkdown, source: 'episode-store' });
  }

  // ... existing fallback logic (keep it exactly as is) ...
}
```

**Important:** Read the actual existing file before modifying it. Match the exact existing response shape. Only add the episode-store read path; do not remove existing fallback logic.

### Step 6: Adapt types to match reality

After implementing the above, run:
```bash
npx tsc --noEmit 2>&1 | head -60
```

Fix all type errors. Common issues to anticipate:
- `BlobEpisodeStore` interface defined in `episode-compat.ts` may conflict with an existing class in `lib/episode-store.ts`. If so, import and re-export from the existing file instead of redefining.
- `lib/storage.ts` may not export `get` — check and use the actual export name (e.g., `getBlob`, `read`, `getBlobContent`).
- `lib/github.ts` may export `getFileContent` under a different name. Check with `grep -n "export" lib/github.ts`.

Resolve each type error, then re-run `npx tsc --noEmit` until clean.

### Step 7: Verify the script is runnable

```bash
# Verify tsx/ts-node is available
npx tsx --version 2>/dev/null || npx ts-node --version

# Dry-run the script (won't actually write to Blob without credentials, but should not throw import errors)
npx tsx scripts/migrate-tlm-memory.ts --help 2>&1 || true
npx tsx --eval "import('./scripts/migrate-tlm-memory.ts')" 2>&1 | head -20 || true
```

The script doesn't need to successfully connect to Blob (that requires real credentials), but it should import cleanly.

### Step 8: Verification

```bash
npx tsc --noEmit
npm run build 2>&1 | tail -20
```

If `npm run build` fails due to missing env vars (Vercel Blob, etc.) but TypeScript compiles cleanly, that is acceptable. The key requirement is `npx tsc --noEmit` passes without errors.

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "feat: TLM memory migration script and episode compat adapter

- Add lib/episode-compat.ts: parseTlmMemory, syncMemoryWindow, renderEpisodeAsMemoryEntry
- Add scripts/migrate-tlm-memory.ts: idempotent migration from tlm-memory.md to BlobEpisodeStore
- Update lib/episode-recorder.ts: sync memory window after recording episode
- Update app/api/agents/tlm-memory/route.ts: read from episode store with legacy fallback"

git push origin feat/tlm-memory-migration-compat-adapter

gh pr create \
  --title "feat: TLM memory migration script and episode compat adapter" \
  --body "## Summary

Bridges the legacy \`tlm-memory.md\` format to the new structured Episode store.

### Changes
- **\`lib/episode-compat.ts\`** (new): Core adapter. Exports \`parseTlmMemory\`, \`syncMemoryWindow\`, \`renderEpisodeAsMemoryEntry\`, \`legacyEntryToEpisode\`, and shared types (\`LegacyMemoryEntry\`, \`Episode\`, \`BlobEpisodeStore\`).
- **\`scripts/migrate-tlm-memory.ts\`** (new): CLI migration script. Reads \`docs/tlm-memory.md\` (local or via GitHub API), parses entries, converts to Episodes, saves to BlobEpisodeStore. Idempotent via SHA-256 content hashing.
- **\`lib/episode-recorder.ts\`** (modified/created): After each episode is saved, regenerates \`af-data/tlm-memory-compat.md\` in Blob for backward compatibility.
- **\`app/api/agents/tlm-memory/route.ts\`** (modified): GET handler now reads from episode store / compat Blob key first, falls back to legacy source. Same response shape.

### Compatibility
- \`GET /api/agents/tlm-memory\` response shape unchanged
- Migration is idempotent; safe to run multiple times
- Does not touch \`app/api/episodes/route.ts\` or \`app/api/episodes/[id]/route.ts\` (concurrent branch)

### Running the migration
\`\`\`bash
# Against local docs/tlm-memory.md
npx tsx scripts/migrate-tlm-memory.ts

# Against a specific file
npx tsx scripts/migrate-tlm-memory.ts --file /path/to/tlm-memory.md

# Against a GitHub repo
npx tsx scripts/migrate-tlm-memory.ts --repo jamesstineheath/agent-forge
\`\`\`"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/tlm-memory-migration-compat-adapter
FILES CHANGED: [list files actually modified]
SUMMARY: [what was implemented]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "type errors in episode-recorder.ts need resolution after lib/episode-store.ts is merged"]
```

## Escalation

If blocked on any of the following, escalate via the API before aborting:
- `BlobEpisodeStore` / `Episode` types exist in the repo but have an incompatible interface requiring architectural decisions.
- `lib/storage.ts` does not expose a way to read back blob content (write-only), making `findByHash` impossible to implement.
- `app/api/agents/tlm-memory/route.ts` has complex auth or response-shaping logic that is unclear.

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "<work-item-id>",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/episode-compat.ts", "scripts/migrate-tlm-memory.ts"]
    }
  }'
```