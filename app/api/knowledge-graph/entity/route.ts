import { NextRequest, NextResponse } from 'next/server';
import { validateAuth } from '@/lib/api-auth';
import { loadGraph } from '@/lib/knowledge-graph/storage';
import { getEntityWithRelationships, queryGraph } from '@/lib/knowledge-graph/query';

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, 'AGENT_FORGE_API_SECRET');
  if (authError) return authError;

  const { searchParams } = new URL(req.url);
  const repo = searchParams.get('repo');
  const id = searchParams.get('id');
  const name = searchParams.get('name');
  const type = searchParams.get('type');

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

  // Lookup by ID
  if (id) {
    const result = getEntityWithRelationships(graph, id);
    if (!result.entity) {
      return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
    }
    return NextResponse.json(result);
  }

  // Lookup by name + optional type
  if (name) {
    const queryResult = queryGraph(graph, {
      namePattern: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      entityType: type as 'function' | 'class' | 'module' | 'file' | 'type' | 'variable' | undefined,
      repo,
    });

    if (queryResult.entities.length === 0) {
      return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
    }

    // Return first match with its relationships
    const result = getEntityWithRelationships(graph, queryResult.entities[0].id);
    return NextResponse.json(result);
  }

  return NextResponse.json(
    { error: 'Provide id or name parameter' },
    { status: 400 },
  );
}
