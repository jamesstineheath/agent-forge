import { saveJson, loadJson, deleteJson } from "../storage";

// === Types ===

export type AgentName = 'dispatcher' | 'health-monitor' | 'project-manager' | 'supervisor';

export interface TracePhase {
  name: string;
  durationMs: number;
  [key: string]: unknown;
}

export interface TraceDecision {
  workItemId?: string;
  action: string;
  reason: string;
  [key: string]: unknown;
}

export interface AgentTrace {
  agent: AgentName;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status?: 'success' | 'error';
  phases: TracePhase[];
  decisions: TraceDecision[];
  errors: string[];
  summary?: string;
  _startMs: number;
}

// === Helpers ===

export function startTrace(agent: AgentName): AgentTrace {
  return {
    agent,
    startedAt: new Date().toISOString(),
    phases: [],
    decisions: [],
    errors: [],
    _startMs: Date.now(),
  };
}

export function addPhase(trace: AgentTrace, phase: TracePhase): void {
  trace.phases.push(phase);
}

export function addDecision(trace: AgentTrace, decision: TraceDecision): void {
  trace.decisions.push(decision);
}

export function addError(trace: AgentTrace, error: string): void {
  trace.errors.push(error);
}

export function completeTrace(
  trace: AgentTrace,
  status: 'success' | 'error',
  summaryOverride?: string
): void {
  trace.completedAt = new Date().toISOString();
  trace.durationMs = Date.now() - trace._startMs;
  trace.status = status;
  trace.summary = summaryOverride ?? generateSummary(trace);
}

function generateSummary(trace: AgentTrace): string {
  const phases = trace.phases.map(p => p.name).join(', ');
  const decisions = trace.decisions.length;
  const errors = trace.errors.length;
  return `${trace.agent} completed ${trace.status} in ${trace.durationMs}ms. Phases: [${phases}]. ${decisions} decision(s), ${errors} error(s).`;
}

// === Persistence ===

export async function persistTrace(trace: AgentTrace): Promise<void> {
  const timestamp = (trace.completedAt ?? trace.startedAt).replace(/:/g, '-');
  const key = `agent-traces/${trace.agent}/${timestamp}`;
  await saveJson(key, trace);
}

export async function cleanupOldTraces(agent: AgentName, retentionDays = 30): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;

  const { list, del } = await import("@vercel/blob");
  const prefix = `af-data/agent-traces/${agent}/`;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  const { blobs } = await list({ prefix, token: process.env.BLOB_READ_WRITE_TOKEN });

  for (const blob of blobs) {
    const filename = blob.pathname.replace(prefix, '').replace('.json', '');
    // Filename is ISO timestamp with colons replaced by dashes
    // e.g. 2026-03-18T12-30-00.000Z
    const isoString = filename.replace(/(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})/, '$1:$2:$3');
    const ts = new Date(isoString).getTime();
    if (!isNaN(ts) && ts < cutoff) {
      await del(blob.url, { token: process.env.BLOB_READ_WRITE_TOKEN });
    }
  }
}

export async function listRecentTraces(agent?: AgentName, limit = 20): Promise<AgentTrace[]> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    // Local dev: try to load from file storage
    return listRecentTracesLocal(agent, limit);
  }

  const { list } = await import("@vercel/blob");
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const prefix = agent
    ? `af-data/agent-traces/${agent}/`
    : `af-data/agent-traces/`;

  const { blobs } = await list({ prefix, token });

  // Sort descending by uploadedAt (most recent first), falling back to pathname
  const sorted = blobs.sort((a, b) => {
    const aTime = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
    const bTime = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
    return bTime - aTime;
  });
  const selected = sorted.slice(0, limit);

  const traces: AgentTrace[] = [];
  for (const blob of selected) {
    try {
      // Extract the storage key from pathname: "af-data/agent-traces/dispatcher/2026-03-18T17-21-41.531Z.json"
      // loadJson expects key without "af-data/" prefix and without ".json" suffix
      const key = blob.pathname.replace(/^af-data\//, '').replace(/\.json$/, '');
      const trace = await loadJson<AgentTrace>(key);
      if (trace) {
        traces.push(trace);
      }
    } catch {
      // Skip individual load errors
    }
  }

  return traces;
}

async function listRecentTracesLocal(agent?: AgentName, limit = 20): Promise<AgentTrace[]> {
  // In local dev, use file system to list traces
  const { readdir } = await import("fs/promises");
  const { join } = await import("path");
  const dataDir = join(process.cwd(), "data");
  const traces: AgentTrace[] = [];

  const agents: AgentName[] = agent
    ? [agent]
    : ['dispatcher', 'health-monitor', 'project-manager', 'supervisor'];

  for (const agentName of agents) {
    const dir = join(dataDir, "agent-traces", agentName);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    const jsonFiles = files.filter(f => f.endsWith('.json')).sort().reverse();
    for (const file of jsonFiles.slice(0, limit)) {
      const key = `agent-traces/${agentName}/${file.replace('.json', '')}`;
      const trace = await loadJson<AgentTrace>(key);
      if (trace) traces.push(trace);
    }
  }

  // Sort all traces descending by startedAt
  traces.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return traces.slice(0, limit);
}
