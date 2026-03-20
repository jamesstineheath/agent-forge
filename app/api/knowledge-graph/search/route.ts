import { NextRequest, NextResponse } from 'next/server';
import { validateAuth } from '@/lib/api-auth';
import { loadGraph } from '@/lib/knowledge-graph/storage';
import { queryGraph } from '@/lib/knowledge-graph/query';
import type { EntityType } from '@/lib/knowledge-graph/types';

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, 'AGENT_FORGE_API_SECRET');
  if (authError) return authError;

  const { searchParams } = new URL(req.url);
  const repo = searchParams.get('repo');
  const q = searchParams.get('q');
  const type = searchParams.get('type') as EntityType | null;
  const limit = parseInt(searchParams.get('limit') ?? '20', 10);

  if (!repo) {
    return NextResponse.json({ error: 'repo is required' }, { status: 400 });
  }

  const graph = await loadGraph(repo);
  if (!graph) {
    return NextResponse.json(
      { error: `No knowledge graph found for ${repo}` },
      { status: 404 },
    );
  }

  const result = queryGraph(graph, {
    namePattern: q ?? undefined,
    entityType: type ?? undefined,
    repo,
  });

  const limited = result.entities.slice(0, limit);

  return NextResponse.json({
    results: limited,
    totalCount: result.totalCount,
  });
}
