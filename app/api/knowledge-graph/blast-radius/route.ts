import { NextRequest, NextResponse } from 'next/server';
import { validateAuth } from '@/lib/api-auth';
import { loadGraph } from '@/lib/knowledge-graph/storage';
import { getBlastRadius } from '@/lib/knowledge-graph/query';

export async function POST(req: NextRequest) {
  const authError = await validateAuth(req, 'AGENT_FORGE_API_SECRET');
  if (authError) return authError;

  const body = await req.json();
  const { repo, filePaths, depth } = body as {
    repo: string;
    filePaths: string[];
    depth?: number;
  };

  if (!repo || !filePaths?.length) {
    return NextResponse.json(
      { error: 'repo and filePaths are required' },
      { status: 400 },
    );
  }

  const graph = await loadGraph(repo);
  if (!graph) {
    return NextResponse.json(
      { error: `No knowledge graph found for ${repo}` },
      { status: 404 },
    );
  }

  const result = getBlastRadius(graph, filePaths, depth ?? 2);

  return NextResponse.json({
    affectedFiles: result.affectedFiles,
    affectedEntities: result.affectedEntities,
    relationships: result.relationships,
    testFiles: result.testFiles,
  });
}
