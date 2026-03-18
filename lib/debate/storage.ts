import { loadJson, saveJson } from '../storage';
import type { DebateSession } from './types';

/** Lightweight index entry for listing without loading full sessions. */
interface DebateSessionIndexEntry {
  id: string;
  repo: string;
  prNumber: number;
  key: string;
}

const INDEX_KEY = 'debates/index';

function sessionKey(repo: string, prNumber: number, id: string): string {
  const encodedRepo = repo.replace('/', '__');
  return `debates/${encodedRepo}/${prNumber}/${id}`;
}

async function loadIndex(): Promise<DebateSessionIndexEntry[]> {
  const index = await loadJson<DebateSessionIndexEntry[]>(INDEX_KEY);
  return index ?? [];
}

async function saveIndex(index: DebateSessionIndexEntry[]): Promise<void> {
  await saveJson(INDEX_KEY, index);
}

export async function saveDebateSession(session: DebateSession): Promise<void> {
  const key = sessionKey(session.repo, session.prNumber, session.id);
  await saveJson(key, session);

  // Update index
  const index = await loadIndex();
  const existing = index.findIndex((e) => e.id === session.id);
  const entry: DebateSessionIndexEntry = {
    id: session.id,
    repo: session.repo,
    prNumber: session.prNumber,
    key,
  };
  if (existing >= 0) {
    index[existing] = entry;
  } else {
    index.push(entry);
  }
  await saveIndex(index);
}

export async function getDebateSession(
  repo: string,
  prNumber: number,
  sessionId: string
): Promise<DebateSession | null> {
  try {
    const key = sessionKey(repo, prNumber, sessionId);
    return await loadJson<DebateSession>(key);
  } catch {
    return null;
  }
}

export async function listDebateSessions(
  repo: string,
  prNumber?: number
): Promise<DebateSession[]> {
  try {
    const index = await loadIndex();
    const filtered = index.filter(
      (e) => e.repo === repo && (prNumber === undefined || e.prNumber === prNumber)
    );

    const sessions: DebateSession[] = [];
    for (const entry of filtered) {
      try {
        const session = await loadJson<DebateSession>(entry.key);
        if (session) sessions.push(session);
      } catch {
        // Skip corrupt entries
      }
    }
    return sessions;
  } catch {
    return [];
  }
}

export async function getDebateStats(): Promise<{
  totalSessions: number;
  avgRounds: number;
  avgTokens: number;
  verdictDistribution: Record<string, number>;
}> {
  const empty = {
    totalSessions: 0,
    avgRounds: 0,
    avgTokens: 0,
    verdictDistribution: {} as Record<string, number>,
  };

  try {
    const index = await loadIndex();
    if (index.length === 0) return empty;

    let totalRounds = 0;
    let totalTokens = 0;
    const verdictDistribution: Record<string, number> = {};
    let validCount = 0;

    for (const entry of index) {
      try {
        const session = await loadJson<DebateSession>(entry.key);
        if (!session) continue;

        validCount++;
        totalRounds += Array.isArray(session.rounds) ? session.rounds.length : 0;
        totalTokens += session.outcome?.tokenUsage?.total ?? 0;

        const verdict = session.outcome?.finalVerdict ?? 'unknown';
        verdictDistribution[verdict] = (verdictDistribution[verdict] ?? 0) + 1;
      } catch {
        // Skip corrupt entries
      }
    }

    if (validCount === 0) return empty;

    return {
      totalSessions: validCount,
      avgRounds: Math.round((totalRounds / validCount) * 100) / 100,
      avgTokens: Math.round((totalTokens / validCount) * 100) / 100,
      verdictDistribution,
    };
  } catch {
    return empty;
  }
}
