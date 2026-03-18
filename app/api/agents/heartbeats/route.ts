import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { loadJson } from '@/lib/storage';
import { HEARTBEAT_BLOB_PREFIX } from '@/lib/atc/types';
import type { AgentHeartbeat } from '@/lib/atc/types';

const AGENT_NAMES = ['dispatcher', 'health-monitor', 'supervisor', 'project-manager'];

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const heartbeats: AgentHeartbeat[] = [];

    for (const agentName of AGENT_NAMES) {
      const key = `${HEARTBEAT_BLOB_PREFIX}/${agentName}/latest`;
      const data = await loadJson<AgentHeartbeat>(key);
      if (data) {
        heartbeats.push(data);
      } else {
        heartbeats.push({
          agentName,
          lastRunAt: '',
          durationMs: 0,
          status: 'ok',
          itemsProcessed: 0,
          notes: 'Never run',
        });
      }
    }

    return NextResponse.json({ heartbeats });
  } catch (err) {
    console.error('[heartbeats API] Error:', err);
    return NextResponse.json({ error: 'Failed to load heartbeats' }, { status: 500 });
  }
}
