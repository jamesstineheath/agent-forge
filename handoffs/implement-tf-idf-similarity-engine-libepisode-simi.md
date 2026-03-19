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
8. Export `updateVocabularyAndIdf(existingIndex: EmbeddingsIndex, newTexts: string[]): EmbeddingsIndex` — incrementally builds/updates vocabulary and IDF values; assigns new vocabulary indices to previously unseen terms; recomputes IDF using document frequency across existing entries + new texts; updates `updatedAt` to current ISO timestamp; returns a new index object (immutable update pattern). **Important:** existing entries' embeddings are NOT re-computed — callers must re-embed entries against the new vocabulary/IDF if they need consistent vectors.
9. `cosineSimilarity([1, 0], [0, 1])` must return `0`.
10. `cosineSimilarity([1, 2], [2, 4])` must return `1.0` (within floating-point epsilon ~1e-9).
11. `findTopK` results are sorted descending by score and the returned array length is `<= k`.
12. `tokenize` is case-insensitive (lowercases input), strips punctuation, and filters common English stop words.
13. Vectors must be capped at 500 dimensions max (vocabulary size ≤ 500). Terms beyond the cap are silently dropped (most-frequent-first ordering determines which terms survive).
14. Performance target: `findTopK` over 5000 entries must complete in <100ms (pure JS, no async needed).
15. No Vercel Blob imports, no fetch calls, no Node.js fs — pure computation only.

## Execution Steps

### Step 0: Branch setup