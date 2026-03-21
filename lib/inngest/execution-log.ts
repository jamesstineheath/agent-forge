// ── Types ────────────────────────────────────────────────────────────────────

export type InngestExecutionLog = {
  functionId: string;
  status: 'running' | 'success' | 'error';
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error?: string;
};

// ── Registry ─────────────────────────────────────────────────────────────────

export const INNGEST_FUNCTION_REGISTRY = [
  {
    id: 'plan-pipeline',
    displayName: 'Plan Pipeline',
    eventName: 'agent-forge/plan-pipeline.run',
  },
  {
    id: 'pipeline-oversight',
    displayName: 'Pipeline Oversight',
    eventName: 'agent-forge/pipeline-oversight.run',
  },
  {
    id: 'pm-sweep',
    displayName: 'PM Sweep',
    eventName: 'agent-forge/pm-sweep.run',
  },
  {
    id: 'housekeeping',
    displayName: 'Housekeeping',
    eventName: 'agent-forge/housekeeping.run',
  },
  {
    id: 'dispatcher-cycle',
    displayName: 'Dispatcher Cycle',
    eventName: 'agent-forge/dispatcher-cycle.run',
  },
  {
    id: 'pm-cycle',
    displayName: 'PM Cycle',
    eventName: 'agent-forge/pm-cycle.run',
  },
  {
    id: 'health-monitor-cycle',
    displayName: 'Health Monitor Cycle',
    eventName: 'agent-forge/health-monitor-cycle.run',
  },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

const blobKey = (functionId: string) =>
  `af-data/inngest-status/${functionId}.json`;

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Persists an execution log entry to Vercel Blob.
 * Silently swallows errors so Blob failures never break agent runs.
 */
export async function writeExecutionLog(log: InngestExecutionLog): Promise<void> {
  try {
    const { put } = await import('@vercel/blob');
    await put(blobKey(log.functionId), JSON.stringify(log), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch {
    // intentionally swallowed — Blob failures must not affect agent execution
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Reads a single execution log from Vercel Blob.
 * Returns null if not found or on any read error.
 */
export async function readExecutionLog(
  functionId: string
): Promise<InngestExecutionLog | null> {
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) return null;

    const { head } = await import('@vercel/blob');
    let blob;
    try {
      blob = await head(blobKey(functionId), { token });
    } catch {
      // Blob not found (404)
      return null;
    }
    const response = await fetch(blob.url, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    return (await response.json()) as InngestExecutionLog;
  } catch {
    return null;
  }
}

/**
 * Reads all 7 execution logs in parallel.
 * Returns a Record keyed by functionId; missing/errored entries are null.
 */
export async function readAllExecutionLogs(): Promise<
  Record<string, InngestExecutionLog | null>
> {
  const entries = await Promise.all(
    INNGEST_FUNCTION_REGISTRY.map(async (fn) => {
      const log = await readExecutionLog(fn.id);
      return [fn.id, log] as const;
    })
  );
  return Object.fromEntries(entries);
}
