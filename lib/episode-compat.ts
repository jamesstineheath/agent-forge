import crypto from "crypto";

// -- Legacy format types --

export interface LegacyMemoryEntry {
  type: "hot_pattern" | "outcome" | "lesson";
  description: string;
  date?: string;
  details?: string;
}

// -- Episode types (no existing episode store — defined here as canonical) --

export type EpisodeOutcome = "success" | "failure" | "partial";

export interface Episode {
  id: string;
  taskDescription: string;
  approach: string;
  outcome: EpisodeOutcome;
  insights: string[];
  contentHash?: string; // SHA-256 prefix, for idempotent migration
  timestamp: string; // ISO 8601
  sourceType?: "hot_pattern" | "outcome" | "lesson" | "live";
}

// -- BlobEpisodeStore (backed by lib/storage.ts loadJson/saveJson) --

export interface EpisodeStoreIndex {
  episodes: Episode[];
}

const EPISODE_INDEX_KEY = "episodes-index";

export class BlobEpisodeStore {
  async save(episode: Episode): Promise<void> {
    const { saveJson, loadJson } = await import("./storage");
    // Save individual episode
    await saveJson(`episodes/${episode.id}`, episode);
    // Update index
    const index = (await loadJson<EpisodeStoreIndex>(EPISODE_INDEX_KEY)) ?? {
      episodes: [],
    };
    // Avoid duplicates
    if (!index.episodes.some((e) => e.id === episode.id)) {
      index.episodes.push(episode);
    } else {
      const idx = index.episodes.findIndex((e) => e.id === episode.id);
      index.episodes[idx] = episode;
    }
    await saveJson(EPISODE_INDEX_KEY, index);
  }

  async list(limit = 20): Promise<Episode[]> {
    const { loadJson } = await import("./storage");
    const index = (await loadJson<EpisodeStoreIndex>(EPISODE_INDEX_KEY)) ?? {
      episodes: [],
    };
    return index.episodes
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )
      .slice(0, limit);
  }

  async findByHash(hash: string): Promise<Episode | null> {
    const { loadJson } = await import("./storage");
    const index = (await loadJson<EpisodeStoreIndex>(EPISODE_INDEX_KEY)) ?? {
      episodes: [],
    };
    return index.episodes.find((e) => e.contentHash === hash) ?? null;
  }
}

// -- Parsing --

/**
 * Parses a tlm-memory.md markdown string into structured LegacyMemoryEntry records.
 *
 * Expected sections:
 *   ## Hot Patterns / ## Recent Outcomes / ## Lessons Learned
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
    const end =
      i + 1 < sections.length ? sections[i + 1].start : markdown.length;
    const body = markdown.slice(section.start, end);

    const type = classifySectionType(section.title);
    if (!type) continue;

    if (type === "outcome") {
      // Parse table rows for outcomes
      const lines = body.split("\n");
      for (const line of lines) {
        const tableMatch = line.match(
          /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/
        );
        if (tableMatch) {
          entries.push({
            type: "outcome",
            description: `${tableMatch[2].trim()} ${tableMatch[3].trim()}`,
            date: tableMatch[1],
            details: tableMatch[5].trim() || undefined,
          });
        }
      }
      continue;
    }

    // Extract bullet list items for hot_pattern and lesson
    const itemRegex = /^[-*]|\d+\.\s/m;
    const lines = body.split("\n");
    let currentEntry: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("##")) {
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
        currentEntry.push(trimmed.replace(/^[-*\d.]\s*/, ""));
      } else if (currentEntry.length > 0) {
        currentEntry.push(trimmed);
      }
    }
    if (currentEntry.length > 0) {
      entries.push(buildEntry(type, currentEntry));
    }
  }

  return entries;
}

function classifySectionType(
  title: string
): LegacyMemoryEntry["type"] | null {
  const t = title.toLowerCase();
  if (t.includes("pattern")) return "hot_pattern";
  if (t.includes("outcome") || t.includes("result")) return "outcome";
  if (t.includes("lesson") || t.includes("learn")) return "lesson";
  return null;
}

function buildEntry(
  type: LegacyMemoryEntry["type"],
  lines: string[]
): LegacyMemoryEntry {
  const [first, ...rest] = lines;
  const dateMatch = first.match(/\[(\d{4}-\d{2}-\d{2})\]/);
  return {
    type,
    description: first
      .replace(/\[(\d{4}-\d{2}-\d{2})\]\s*/, "")
      .trim(),
    date: dateMatch?.[1],
    details: rest.join(" ").trim() || undefined,
  };
}

// -- Outcome mapping --

export function mapOutcome(entry: LegacyMemoryEntry): EpisodeOutcome {
  const combined =
    `${entry.description} ${entry.details ?? ""}`.toLowerCase();
  if (
    combined.includes("reversed") ||
    combined.includes("caused issues") ||
    combined.includes("caused_issues") ||
    combined.includes("broke") ||
    combined.includes("failure") ||
    combined.includes("failed")
  ) {
    return "failure";
  }
  if (
    combined.includes("missed") ||
    combined.includes("partial") ||
    combined.includes("premature") ||
    combined.includes("incomplete")
  ) {
    return "partial";
  }
  return "success";
}

// -- Content hash --

export function contentHash(entry: LegacyMemoryEntry): string {
  const payload = JSON.stringify({
    type: entry.type,
    description: entry.description,
    details: entry.details ?? "",
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// -- Legacy entry -> Episode conversion --

export function legacyEntryToEpisode(entry: LegacyMemoryEntry): Episode {
  const hash = contentHash(entry);
  return {
    id: `migrated-${hash}`,
    taskDescription: entry.description,
    approach: entry.details ?? entry.description,
    outcome: mapOutcome(entry),
    insights: entry.details ? [entry.details] : [],
    contentHash: hash,
    timestamp: entry.date
      ? new Date(entry.date).toISOString()
      : new Date(0).toISOString(),
    sourceType: entry.type,
  };
}

// -- Rendering --

/**
 * Renders a single Episode in the legacy tlm-memory.md bullet style.
 */
export function renderEpisodeAsMemoryEntry(episode: Episode): string {
  const dateStr =
    episode.timestamp && episode.timestamp !== new Date(0).toISOString()
      ? ` (${episode.timestamp.slice(0, 10)})`
      : "";
  const outcomeLabel =
    episode.outcome === "success"
      ? "correct"
      : episode.outcome === "failure"
        ? "caused_issues"
        : "premature";
  const insightStr =
    episode.insights.length > 0
      ? `\n  - ${episode.insights.join("\n  - ")}`
      : "";
  return `- ${outcomeLabel}: ${episode.taskDescription}${dateStr}${insightStr}`;
}

/**
 * Reads the 20 most recent episodes from the store and renders them as a
 * tlm-memory.md compatible markdown string.
 */
export async function syncMemoryWindow(
  store: BlobEpisodeStore
): Promise<string> {
  const episodes = await store.list(20);

  const hotPatterns = episodes.filter(
    (e) => e.sourceType === "hot_pattern" || e.sourceType === "live"
  );
  const outcomes = episodes.filter((e) => e.sourceType === "outcome");
  const lessons = episodes.filter((e) => e.sourceType === "lesson");

  // If no sourceType segregation, put all in outcomes
  const allFallback =
    hotPatterns.length === 0 && outcomes.length === 0 && lessons.length === 0
      ? episodes
      : [];

  const lines: string[] = [
    "# TLM Memory",
    "",
    `> Auto-generated from episode store. Last synced: ${new Date().toISOString()}`,
    "",
  ];

  const renderSection = (title: string, items: Episode[]) => {
    if (items.length === 0) return;
    lines.push(`## ${title}`, "");
    for (const ep of items) {
      lines.push(renderEpisodeAsMemoryEntry(ep));
    }
    lines.push("");
  };

  if (allFallback.length > 0) {
    renderSection("Recent Outcomes", allFallback);
  } else {
    renderSection("Hot Patterns", hotPatterns);
    renderSection("Recent Outcomes", outcomes);
    renderSection("Lessons Learned", lessons);
  }

  return lines.join("\n");
}
