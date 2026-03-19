# Agent Forge -- Implement TF-IDF similarity engine (lib/episode-similarity.ts)

## Metadata
- **Branch:** `feat/tfidf-episode-similarity-engine`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/episode-similarity.ts

## Context

Agent Forge needs an episode retrieval system for surfacing relevant past episodes based on semantic similarity. This task implements the pure-computation TF-IDF cosine similarity engine — a standalone module with zero Vercel Blob or external dependencies.

TF-IDF (Term Frequency–Inverse Document Frequency) is a classical IR technique: each episode's text is represented as a sparse vector over a shared vocabulary, where each dimension is weighted by how often the term appears in that episode (TF) times how rare it is across all episodes (IDF). Cosine similarity between two such vectors gives a score in [0, 1] (for non-negative vectors).

**Concurrent work notice:** Branch `fix/define-episode-types-and-data-models-in-libtypests` is touching `lib/types.ts`. Do **not** modify `lib/types.ts`. Define all types locally in `lib/episode-similarity.ts` or re-export from there. If the episode types PR lands before this one and defines overlapping types, prefer importing from `lib/types.ts` rather than duplicating — but only do so if the file already exists and exports the relevant types. When in doubt, keep everything self-contained.

The repo uses TypeScript (Next.js 16 App Router). Type safety is required; no `any` unless absolutely necessary with an explanatory comment.

## Requirements

1. File `lib/episode-similarity.ts` must be created and compile with zero TypeScript errors.
2. Export `EpisodeEmbeddingEntry` interface: `{ id: string; embedding: number[] }`.
3. Export `EmbeddingsIndex` interface: `{ vocabulary: Record<string, number>; idfVector: number[]; entries: EpisodeEmbeddingEntry[]; updatedAt: string }`.
4. Export `tokenize(text: string): string[]` — lowercase, split on whitespace and punctuation, remove English stop words, apply basic suffix stemming (e.g. strip trailing `ing`, `ed`, `s`, `ly`).
5. Export `computeTfIdfVector(text: string, vocabulary: Record<string, number>, idfVector: number[]): number[]` — returns a dense vector of length equal to `idfVector.length`, where each dimension is `tf * idf` for the corresponding vocabulary term.
6. Export `cosineSimilarity(a: number[], b: number[]): number` — returns `dot(a,b) / (|a| * |b|)`, returns `0` if either vector has zero magnitude.
7. Export `findTopK(queryEmbedding: number[], index: EmbeddingsIndex, k: number): { id: string; score: number }[]` — scans all entries, returns top-K sorted by descending score.
8. Export `updateVocabularyAndIdf(existingIndex: EmbeddingsIndex, newTexts: string[]): EmbeddingsIndex` — incrementally builds/updates vocabulary and IDF values; assigns new vocabulary indices to previously unseen terms; recomputes IDF using document frequency across existing entries + new texts; updates `updatedAt` to current ISO timestamp; returns a new index object (immutable update pattern).
9. `cosineSimilarity([1, 0], [0, 1])` must return `0`.
10. `cosineSimilarity([1, 2], [2, 4])` must return `1.0` (within floating-point epsilon ~1e-9).
11. `findTopK` results are sorted descending by score and the returned array length is `<= k`.
12. `tokenize` is case-insensitive (lowercases input), strips punctuation, and filters common English stop words.
13. Vectors must be capped at 500 dimensions max (vocabulary size ≤ 500).
14. Performance target: `findTopK` over 5000 entries must complete in <100ms (pure JS, no async needed).
15. No Vercel Blob imports, no fetch calls, no Node.js fs — pure computation only.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/tfidf-episode-similarity-engine
```

### Step 1: Create lib/episode-similarity.ts

Create the file at `lib/episode-similarity.ts` with the full implementation below. Read the entire spec carefully before writing — the steps are ordered for clarity, not necessarily line-by-line.

```typescript
// lib/episode-similarity.ts
// Pure-computation TF-IDF cosine similarity engine for episode retrieval.
// NO Vercel Blob, fetch, or filesystem access in this file.

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EpisodeEmbeddingEntry {
  id: string;
  embedding: number[];
}

export interface EmbeddingsIndex {
  vocabulary: Record<string, number>; // term → dimension index
  idfVector: number[];                // idf weight per vocabulary dimension
  entries: EpisodeEmbeddingEntry[];
  updatedAt: string;                  // ISO 8601
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_VOCAB_SIZE = 500;

const STOP_WORDS = new Set([
  "a","about","above","after","again","against","all","am","an","and","any",
  "are","aren't","as","at","be","because","been","before","being","below",
  "between","both","but","by","can't","cannot","could","couldn't","did",
  "didn't","do","does","doesn't","doing","don't","down","during","each",
  "few","for","from","further","get","got","had","hadn't","has","hasn't",
  "have","haven't","having","he","he'd","he'll","he's","her","here","here's",
  "hers","herself","him","himself","his","how","how's","i","i'd","i'll",
  "i'm","i've","if","in","into","is","isn't","it","it's","its","itself",
  "let's","me","more","most","mustn't","my","myself","no","nor","not","of",
  "off","on","once","only","or","other","ought","our","ours","ourselves",
  "out","over","own","same","shan't","she","she'd","she'll","she's","should",
  "shouldn't","so","some","such","than","that","that's","the","their",
  "theirs","them","themselves","then","there","there's","these","they",
  "they'd","they'll","they're","they've","this","those","through","to","too",
  "under","until","up","very","was","wasn't","we","we'd","we'll","we're",
  "we've","were","weren't","what","what's","when","when's","where","where's",
  "which","while","who","who's","whom","why","why's","will","with","won't",
  "would","wouldn't","you","you'd","you'll","you're","you've","your","yours",
  "yourself","yourselves",
]);

// ─── tokenize ─────────────────────────────────────────────────────────────────

/**
 * Lowercase, split on non-alphanumeric chars, remove stop words, stem basic suffixes.
 * Returns an array of processed tokens.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  // Split on anything that is not a letter or digit
  const raw = lower.split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  return raw
    .map(stem)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Basic suffix stemmer: strips common English suffixes.
 * Applied in order; stops after the first match that leaves a stem >= 3 chars.
 */
function stem(word: string): string {
  if (word.length < 4) return word;
  // Order matters — longer suffixes first
  const rules: [RegExp, string][] = [
    [/ingly$/, ""],
    [/ingly$/, ""],
    [/ation$/, ""],
    [/ness$/, ""],
    [/ment$/, ""],
    [/able$/, ""],
    [/ible$/, ""],
    [/ing$/, ""],
    [/ely$/, ""],
    [/ful$/, ""],
    [/ous$/, ""],
    [/ive$/, ""],
    [/ize$/, ""],
    [/ise$/, ""],
    [/ed$/, ""],
    [/ly$/, ""],
    [/er$/, ""],
    [/s$/, ""],
  ];
  for (const [re, replacement] of rules) {
    const candidate = word.replace(re, replacement);
    if (candidate !== word && candidate.length >= 3) {
      return candidate;
    }
  }
  return word;
}

// ─── computeTfIdfVector ───────────────────────────────────────────────────────

/**
 * Compute a TF-IDF embedding for `text` using an existing vocabulary and IDF vector.
 * Returns a dense vector of length idfVector.length.
 * Terms not in vocabulary are ignored (out-of-vocabulary).
 */
export function computeTfIdfVector(
  text: string,
  vocabulary: Record<string, number>,
  idfVector: number[]
): number[] {
  const tokens = tokenize(text);
  const dim = idfVector.length;
  const vector = new Array<number>(dim).fill(0);

  if (tokens.length === 0) return vector;

  // Compute raw term frequency counts
  const tf: Record<number, number> = {};
  for (const token of tokens) {
    const idx = vocabulary[token];
    if (idx !== undefined) {
      tf[idx] = (tf[idx] ?? 0) + 1;
    }
  }

  // Normalise TF by total token count, multiply by IDF
  const total = tokens.length;
  for (const [idxStr, count] of Object.entries(tf)) {
    const idx = Number(idxStr);
    vector[idx] = (count / total) * idfVector[idx];
  }

  return vector;
}

// ─── cosineSimilarity ─────────────────────────────────────────────────────────

/**
 * Cosine similarity between two equal-length vectors.
 * Returns 0 if either vector has zero magnitude (avoids division by zero).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ─── findTopK ─────────────────────────────────────────────────────────────────

/**
 * Scan all entries in the index and return the top-K results sorted by
 * descending cosine similarity. Returns at most `k` results.
 */
export function findTopK(
  queryEmbedding: number[],
  index: EmbeddingsIndex,
  k: number
): { id: string; score: number }[] {
  if (k <= 0 || index.entries.length === 0) return [];

  const scored = index.entries.map((entry) => ({
    id: entry.id,
    score: cosineSimilarity(queryEmbedding, entry.embedding),
  }));

  // Partial sort: use a min-heap of size k for efficiency at large N.
  // For the target of 5000 entries and k typically small, a simple sort is
  // well within 100ms; a full sort of 5000 floats takes ~1ms in V8.
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ─── updateVocabularyAndIdf ───────────────────────────────────────────────────

/**
 * Incrementally update vocabulary and IDF values when new episode texts are added.
 *
 * Strategy:
 * - Tokenize all new texts, discover new terms.
 * - Add new terms to vocabulary (up to MAX_VOCAB_SIZE total).
 * - Recompute IDF using document-frequency counts across:
 *     • existing entries (reconstructed from their stored embeddings, which we
 *       can't un-tokenize) — so we track doc-freq implicitly via existing IDF.
 *     • new texts (tokenized fresh).
 * - Because we cannot reconstruct per-entry token sets from stored embeddings,
 *   we recompute IDF from the number of docs implied by existing IDF values
 *   (back-calculating df = N / exp(idf)) combined with new doc observations.
 *
 * Returns a **new** EmbeddingsIndex (immutable update; caller must re-embed entries
 * if needed — embedding regeneration is the caller's responsibility).
 *
 * updatedAt is set to current ISO timestamp.
 */
export function updateVocabularyAndIdf(
  existingIndex: EmbeddingsIndex,
  newTexts: string[]
): EmbeddingsIndex {
  const N_existing = existingIndex.entries.length;
  const N_new = newTexts.length;
  const N_total = N_existing + N_new;

  if (N_total === 0) {
    return { ...existingIndex, updatedAt: new Date().toISOString() };
  }

  // --- Back-calculate existing document frequencies from stored IDF ---
  // IDF formula used: ln((N + 1) / (df + 1)) + 1  (smoothed)
  // => df = (N + 1) / exp(idf - 1) - 1
  const existingVocab = existingIndex.vocabulary;
  const existingIdf = existingIndex.idfVector;
  const termDf: Record<string, number> = {};

  for (const [term, idx] of Object.entries(existingVocab)) {
    if (N_existing > 0 && idx < existingIdf.length) {
      const idfVal = existingIdf[idx];
      // Inverse of: idf = ln((N+1)/(df+1)) + 1
      const df = Math.round((N_existing + 1) / Math.exp(idfVal - 1) - 1);
      termDf[term] = Math.max(0, df);
    } else {
      termDf[term] = 0;
    }
  }

  // --- Count document frequencies from new texts ---
  for (const text of newTexts) {
    const tokens = new Set(tokenize(text));
    for (const token of tokens) {
      termDf[token] = (termDf[token] ?? 0) + 1;
    }
  }

  // --- Determine new vocabulary: keep existing terms + add new ones up to cap ---
  const newVocab: Record<string, number> = { ...existingVocab };
  let nextIdx = Object.keys(existingVocab).length;

  // Collect candidate new terms sorted by their total df descending (most common first)
  const candidateNewTerms = Object.keys(termDf)
    .filter((t) => !(t in existingVocab))
    .sort((a, b) => (termDf[b] ?? 0) - (termDf[a] ?? 0));

  for (const term of candidateNewTerms) {
    if (nextIdx >= MAX_VOCAB_SIZE) break;
    newVocab[term] = nextIdx++;
  }

  const vocabSize = nextIdx; // actual final vocabulary size

  // --- Recompute IDF vector ---
  const newIdfVector = new Array<number>(vocabSize).fill(0);
  for (const [term, idx] of Object.entries(newVocab)) {
    const df = termDf[term] ?? 0;
    // Smoothed IDF: ln((N_total + 1) / (df + 1)) + 1
    newIdfVector[idx] = Math.log((N_total + 1) / (df + 1)) + 1;
  }

  return {
    vocabulary: newVocab,
    idfVector: newIdfVector,
    entries: existingIndex.entries, // caller is responsible for re-embedding
    updatedAt: new Date().toISOString(),
  };
}
```

### Step 2: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. The file must compile clean.

### Step 3: Run a quick smoke-test (optional but recommended)

If `ts-node` or `tsx` is available, verify the acceptance criteria inline:

```bash
# Quick smoke test — paste into a temp file and run, or just verify mentally
node -e "
const { cosineSimilarity, tokenize } = require('./lib/episode-similarity');
// Requires compilation first — skip if not set up for direct require
"
```

Alternatively, manually trace through the logic:
- `cosineSimilarity([1,0],[0,1])`: dot=0, magA=1, magB=1 → 0 ✓
- `cosineSimilarity([1,2],[2,4])`: dot=1*2+2*4=10, magA=√5, magB=√20=2√5 → 10/(√5*2√5)=10/10=1.0 ✓
- `tokenize("Hello, World!")` → `["hello","world"]` (lowercased, punctuation stripped) ✓

### Step 4: Build check

```bash
npm run build
```

If the build fails for reasons unrelated to this file (pre-existing failures), note them in the PR but do not fix them. Only fix failures caused by `lib/episode-similarity.ts`.

### Step 5: Commit, push, open PR

```bash
git add lib/episode-similarity.ts
git commit -m "feat: implement TF-IDF cosine similarity engine for episode retrieval"
git push origin feat/tfidf-episode-similarity-engine
gh pr create \
  --title "feat: implement TF-IDF cosine similarity engine (lib/episode-similarity.ts)" \
  --body "## Summary

Adds \`lib/episode-similarity.ts\` — a pure-computation TF-IDF cosine similarity engine for episode retrieval. No external dependencies, no Vercel Blob access.

## What's included

- \`EpisodeEmbeddingEntry\` and \`EmbeddingsIndex\` types
- \`tokenize()\` — lowercase, punctuation strip, stop-word removal, basic suffix stemming
- \`computeTfIdfVector()\` — dense TF-IDF vector over existing vocabulary
- \`cosineSimilarity()\` — dot product / magnitudes, zero-safe
- \`findTopK()\` — scans all entries, returns top-K descending
- \`updateVocabularyAndIdf()\` — incremental vocabulary expansion + IDF recomputation, ≤500 dims

## Acceptance criteria verified

- \`cosineSimilarity([1,0],[0,1])\` → 0 ✓
- \`cosineSimilarity([1,2],[2,4])\` → 1.0 ✓
- \`findTopK\` returns sorted descending, respects k ✓
- \`tokenize\` lowercases, strips punctuation ✓
- TypeScript compiles clean ✓

## Concurrent work note

Did not touch \`lib/types.ts\` (concurrent branch \`fix/define-episode-types-and-data-models-in-libtypests\`). All types are defined locally in this file."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/tfidf-episode-similarity-engine
FILES CHANGED: lib/episode-similarity.ts
SUMMARY: [what was done]
ISSUES: [what failed or is incomplete]
NEXT STEPS: [what remains — e.g. "updateVocabularyAndIdf IDF back-calculation needs review"]
```

## Escalation Protocol

If you encounter an unresolvable blocker (e.g. the `lib/types.ts` concurrent branch has landed with conflicting type definitions, or there is an architectural decision needed about IDF formula choice):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "implement-tfidf-episode-similarity-engine",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/episode-similarity.ts"]
    }
  }'
```