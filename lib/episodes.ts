import { loadJson, saveJson } from "./storage";

// --- Episode Types ---

export type EpisodeOutcome = "success" | "failure" | "partial";

export interface Episode {
  id: string;
  title: string;
  workItemId?: string;
  targetRepo: string;
  outcome: EpisodeOutcome;
  summary: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  cost?: number;
  prUrl?: string;
  createdAt: string;
}

export interface EpisodeSearchParams {
  q?: string;
  from?: string;
  to?: string;
  outcome?: EpisodeOutcome;
  cursor?: string;
  limit: number;
}

export interface EpisodeSearchResult {
  episodes: Episode[];
  nextCursor?: string;
}

// --- Episode Index ---

export interface EpisodeIndexEntry {
  id: string;
  title: string;
  targetRepo: string;
  outcome: EpisodeOutcome;
  completedAt: string;
}

const INDEX_KEY = "episodes/index";

function itemKey(id: string): string {
  return `episodes/${id}`;
}

async function loadIndex(): Promise<EpisodeIndexEntry[]> {
  const index = await loadJson<EpisodeIndexEntry[]>(INDEX_KEY);
  return index ?? [];
}

// --- BlobEpisodeStore ---

export const BlobEpisodeStore = {
  async get(id: string): Promise<Episode | null> {
    return loadJson<Episode>(itemKey(id));
  },

  async search(params: EpisodeSearchParams): Promise<EpisodeSearchResult> {
    let index = await loadIndex();

    // Sort by completedAt descending (most recent first)
    index.sort(
      (a, b) =>
        new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime()
    );

    // Filter by outcome
    if (params.outcome) {
      index = index.filter((e) => e.outcome === params.outcome);
    }

    // Filter by date range
    if (params.from) {
      const fromMs = new Date(params.from).getTime();
      index = index.filter(
        (e) => new Date(e.completedAt).getTime() >= fromMs
      );
    }
    if (params.to) {
      const toMs = new Date(params.to).getTime();
      index = index.filter(
        (e) => new Date(e.completedAt).getTime() <= toMs
      );
    }

    // Filter by search query (title match)
    if (params.q) {
      const q = params.q.toLowerCase();
      index = index.filter((e) => e.title.toLowerCase().includes(q));
    }

    // Cursor-based pagination: cursor is the ID of the last item from the previous page
    if (params.cursor) {
      const cursorIdx = index.findIndex((e) => e.id === params.cursor);
      if (cursorIdx !== -1) {
        index = index.slice(cursorIdx + 1);
      }
    }

    const limit = params.limit;
    const page = index.slice(0, limit);
    const hasMore = index.length > limit;

    // Load full episode objects
    const episodes = (
      await Promise.all(page.map((e) => this.get(e.id)))
    ).filter((e): e is Episode => e !== null);

    return {
      episodes,
      ...(hasMore && page.length > 0
        ? { nextCursor: page[page.length - 1].id }
        : {}),
    };
  },

  async create(episode: Episode): Promise<Episode> {
    await saveJson(itemKey(episode.id), episode);

    const index = await loadIndex();
    index.push({
      id: episode.id,
      title: episode.title,
      targetRepo: episode.targetRepo,
      outcome: episode.outcome,
      completedAt: episode.completedAt,
    });
    await saveJson(INDEX_KEY, index);

    return episode;
  },
};
