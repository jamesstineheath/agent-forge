import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import type {
  TLMMemory,
  TLMHotPattern,
  TLMOutcome,
  TLMLesson,
  TLMMemoryStats,
} from "@/lib/types";
import { BlobEpisodeStore, syncMemoryWindow } from "@/lib/episode-compat";
import { MEMORY_COMPAT_KEY } from "@/lib/episode-recorder";
import { loadJson } from "@/lib/storage";

export const revalidate = 300;

function parseHotPatterns(content: string): TLMHotPattern[] {
  const section = content.match(
    /## Hot Patterns[\s\S]*?(?=\n## )/
  );
  if (!section) return [];

  const patterns: TLMHotPattern[] = [];
  const lines = section[0].split("\n");
  for (const line of lines) {
    const match = line.match(/^- \[(\d{4}-\d{2}-\d{2})\]\s+(.+)/);
    if (match) {
      patterns.push({ date: match[1], pattern: match[2] });
    }
  }
  return patterns;
}

function parseRecentOutcomes(content: string): TLMOutcome[] {
  const section = content.match(
    /## Recent Outcomes[\s\S]*?(?=\n## )/
  );
  if (!section) return [];

  const outcomes: TLMOutcome[] = [];
  const lines = section[0].split("\n");
  for (const line of lines) {
    // Match table rows: | Date | Action | Entity | Outcome | Notes |
    const match = line.match(
      /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/
    );
    if (match) {
      outcomes.push({
        date: match[1],
        action: match[2].trim(),
        entity: match[3].trim(),
        outcome: match[4].trim(),
        notes: match[5].trim(),
      });
    }
  }
  return outcomes;
}

function parseLessonsLearned(content: string): TLMLesson[] {
  const section = content.match(
    /## Lessons Learned[\s\S]*?(?=\n## )/
  );
  if (!section) return [];

  const lessons: TLMLesson[] = [];
  const lines = section[0].split("\n");
  for (const line of lines) {
    const match = line.match(/^- (PR #\d+):\s+(.+)/);
    if (match) {
      lessons.push({ date: match[1], lesson: match[2] });
    }
  }
  return lessons;
}

function parseStats(content: string): TLMMemoryStats {
  const defaults: TLMMemoryStats = {
    totalAssessed: 0,
    correct: 0,
    reversed: 0,
    causedIssues: 0,
    missed: 0,
    lastAssessment: "",
  };

  const section = content.match(/## Stats[\s\S]*$/);
  if (!section) return defaults;

  const text = section[0];
  const totalMatch = text.match(/Total Assessed:\s*(\d+)/);
  const correctMatch = text.match(/Correct:\s*(\d+)/);
  const reversedMatch = text.match(/Reversed:\s*(\d+)/);
  const causedMatch = text.match(/Caused Issues:\s*(\d+)/);
  const missedMatch = text.match(/Missed:\s*(\d+)/);
  const lastMatch = text.match(/Last Assessment:\s*(.+)/);

  return {
    totalAssessed: totalMatch ? parseInt(totalMatch[1], 10) : 0,
    correct: correctMatch ? parseInt(correctMatch[1], 10) : 0,
    reversed: reversedMatch ? parseInt(reversedMatch[1], 10) : 0,
    causedIssues: causedMatch ? parseInt(causedMatch[1], 10) : 0,
    missed: missedMatch ? parseInt(missedMatch[1], 10) : 0,
    lastAssessment: lastMatch ? lastMatch[1].trim() : "",
  };
}

/**
 * Attempts to read TLM memory from the episode store (compat blob or live sync).
 * Returns parsed markdown content or null if unavailable.
 */
async function getEpisodeStoreMarkdown(): Promise<string | null> {
  // 1. Try the cached compat blob
  try {
    const cached = await loadJson<{ markdown: string }>(MEMORY_COMPAT_KEY);
    if (cached?.markdown && cached.markdown.trim().length > 0) {
      return cached.markdown;
    }
  } catch {
    /* fall through */
  }

  // 2. Try live sync from episode store
  try {
    const store = new BlobEpisodeStore();
    const episodes = await store.list(20);
    if (episodes.length > 0) {
      return await syncMemoryWindow(store);
    }
  } catch {
    /* fall through to legacy */
  }

  return null;
}

export async function GET(_req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Try episode store first
    const episodeMarkdown = await getEpisodeStoreMarkdown();
    if (episodeMarkdown) {
      const memory: TLMMemory = {
        hotPatterns: parseHotPatterns(episodeMarkdown),
        recentOutcomes: parseRecentOutcomes(episodeMarkdown),
        lessonsLearned: parseLessonsLearned(episodeMarkdown),
        stats: parseStats(episodeMarkdown),
      };
      return NextResponse.json(memory);
    }
  } catch {
    // Fall through to legacy GitHub source
  }

  // Legacy: read from GitHub
  const token = process.env.GH_PAT;
  if (!token) {
    return NextResponse.json(
      { error: "GH_PAT not configured" },
      { status: 500 }
    );
  }

  try {
    const response = await fetch(
      "https://api.github.com/repos/jamesstineheath/agent-forge/contents/docs/tlm-memory.md",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3.raw",
        },
        next: { revalidate: 300 },
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return NextResponse.json(
          { error: "TLM memory file not found" },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { error: "Failed to fetch TLM memory" },
        { status: response.status }
      );
    }

    const content = await response.text();

    const memory: TLMMemory = {
      hotPatterns: parseHotPatterns(content),
      recentOutcomes: parseRecentOutcomes(content),
      lessonsLearned: parseLessonsLearned(content),
      stats: parseStats(content),
    };

    return NextResponse.json(memory);
  } catch (error) {
    console.error("[tlm-memory] Failed to fetch/parse:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
