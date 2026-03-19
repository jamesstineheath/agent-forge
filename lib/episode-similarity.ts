// ---------------------------------------------------------------------------
// TF-IDF Cosine Similarity Engine — pure computation, zero external deps
// ---------------------------------------------------------------------------

const MAX_VOCABULARY_SIZE = 500;

// --- Types ---

export interface EpisodeEmbeddingEntry {
  id: string;
  embedding: number[];
}

export interface EmbeddingsIndex {
  vocabulary: Record<string, number>;
  idfVector: number[];
  entries: EpisodeEmbeddingEntry[];
  updatedAt: string;
}

// --- Stop Words ---

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "as", "be", "was", "are",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "shall", "can", "need",
  "dare", "ought", "used", "this", "that", "these", "those", "i", "me",
  "my", "myself", "we", "our", "ours", "ourselves", "you", "your",
  "yours", "yourself", "yourselves", "he", "him", "his", "himself",
  "she", "her", "hers", "herself", "its", "itself", "they", "them",
  "their", "theirs", "themselves", "what", "which", "who", "whom",
  "when", "where", "why", "how", "all", "each", "every", "both", "few",
  "more", "most", "other", "some", "such", "no", "nor", "not", "only",
  "own", "same", "so", "than", "too", "very", "just", "because",
  "about", "into", "through", "during", "before", "after", "above",
  "below", "between", "out", "off", "over", "under", "again", "further",
  "then", "once", "here", "there", "if", "up", "down", "am",
]);

// --- Tokenizer ---

/**
 * Lowercase, split on whitespace/punctuation, remove stop words, apply basic
 * suffix stemming (strip trailing -ing, -ed, -ly, -s).
 */
export function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);

  const result: string[] = [];
  for (const token of tokens) {
    if (STOP_WORDS.has(token)) continue;
    result.push(stem(token));
  }
  return result;
}

function stem(word: string): string {
  // Order matters: try longer suffixes first
  if (word.length > 4 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 3 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("ly")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss"))
    return word.slice(0, -1);
  return word;
}

// --- TF-IDF Vector ---

export function computeTfIdfVector(
  text: string,
  vocabulary: Record<string, number>,
  idfVector: number[],
): number[] {
  const tokens = tokenize(text);
  const vecLength = idfVector.length;
  const vec = new Array<number>(vecLength).fill(0);

  // Count term frequencies
  const tf = new Map<number, number>();
  for (const token of tokens) {
    const idx = vocabulary[token];
    if (idx === undefined) continue;
    tf.set(idx, (tf.get(idx) ?? 0) + 1);
  }

  // TF * IDF
  for (const [idx, count] of tf) {
    vec[idx] = count * idfVector[idx];
  }

  return vec;
}

// --- Cosine Similarity ---

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

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

// --- Top-K Search ---

export function findTopK(
  queryEmbedding: number[],
  index: EmbeddingsIndex,
  k: number,
): { id: string; score: number }[] {
  const scored: { id: string; score: number }[] = [];

  for (const entry of index.entries) {
    const score = cosineSimilarity(queryEmbedding, entry.embedding);
    scored.push({ id: entry.id, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// --- Vocabulary & IDF Update ---

export function updateVocabularyAndIdf(
  existingIndex: EmbeddingsIndex,
  newTexts: string[],
): EmbeddingsIndex {
  // Tokenize new texts
  const newTokenSets: Set<string>[] = newTexts.map(
    (text) => new Set(tokenize(text)),
  );

  // Collect global document frequencies: start from existing entries
  // We need to rebuild doc frequencies from scratch since we don't store them.
  // Re-tokenize existing entry texts is not possible (we only have embeddings).
  // Instead, we infer DF from existing IDF: idf = ln(N / df) => df = N / e^idf
  // But this loses precision. The spec says "recomputes IDF using document
  // frequency across existing entries + new texts". Since we can't recover
  // original texts from embeddings, we track DF from the vocabulary indices
  // that have non-zero IDF values, combined with new text frequencies.

  const existingEntryCount = existingIndex.entries.length;
  const totalDocs = existingEntryCount + newTexts.length;

  // Reconstruct document frequencies from existing IDF vector
  // idf_i = ln((N+1) / (df_i + 1)), so df_i = (N+1) / exp(idf_i) - 1
  const existingVocab = { ...existingIndex.vocabulary };
  const docFreq = new Map<string, number>();

  for (const [term, idx] of Object.entries(existingVocab)) {
    if (idx < existingIndex.idfVector.length) {
      const idfVal = existingIndex.idfVector[idx];
      // Recover approximate DF from IDF
      const approxDf = Math.round(
        (existingEntryCount + 1) / Math.exp(idfVal) - 1,
      );
      docFreq.set(term, Math.max(approxDf, 0));
    }
  }

  // Count term frequencies across all texts (existing inferred + new)
  // Also collect all term global frequencies for cap selection
  const termGlobalFreq = new Map<string, number>();

  // Accumulate from existing
  for (const [term, df] of docFreq) {
    termGlobalFreq.set(term, df);
  }

  // Add from new texts
  for (const tokenSet of newTokenSets) {
    for (const token of tokenSet) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
      termGlobalFreq.set(token, (termGlobalFreq.get(token) ?? 0) + 1);
    }
  }

  // If vocabulary exceeds max, keep only the most frequent terms
  let selectedTerms: string[];
  if (termGlobalFreq.size <= MAX_VOCABULARY_SIZE) {
    selectedTerms = Array.from(termGlobalFreq.keys());
  } else {
    selectedTerms = Array.from(termGlobalFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_VOCABULARY_SIZE)
      .map(([term]) => term);
  }

  // Build new vocabulary mapping
  const newVocabulary: Record<string, number> = {};
  selectedTerms.forEach((term, idx) => {
    newVocabulary[term] = idx;
  });

  // Compute new IDF vector
  const newIdfVector: number[] = selectedTerms.map((term) => {
    const df = docFreq.get(term) ?? 0;
    return Math.log((totalDocs + 1) / (df + 1));
  });

  return {
    vocabulary: newVocabulary,
    idfVector: newIdfVector,
    entries: existingIndex.entries,
    updatedAt: new Date().toISOString(),
  };
}
