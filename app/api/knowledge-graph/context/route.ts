import { NextRequest, NextResponse } from 'next/server';
import { validateAuth } from '@/lib/api-auth';
import { loadGraph } from '@/lib/knowledge-graph/storage';
import {
  getBlastRadius,
  getRelevantSystemMapSections,
  getRelevantADRs,
} from '@/lib/knowledge-graph/query';
import { fetchRepoContext } from '@/lib/orchestrator';
import { listRepos, getRepo } from '@/lib/repos';

export async function POST(req: NextRequest) {
  const authError = await validateAuth(req, 'AGENT_FORGE_API_SECRET');
  if (authError) return authError;

  const body = await req.json();
  const { repo, filePaths, entityNames } = body as {
    repo: string;
    filePaths: string[];
    entityNames?: string[];
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

  // Fetch repo context for system map, ADRs, CLAUDE.md
  const repoIndex = await listRepos();
  const repoEntry = repoIndex.find((r) => r.fullName === repo);
  let systemMapSections = '';
  let relevantADRs: string[] = [];
  let claudeMdSections = '';

  if (repoEntry) {
    const repoConfig = await getRepo(repoEntry.id);
    if (repoConfig) {
      const ctx = await fetchRepoContext(repoConfig);
      claudeMdSections = ctx.claudeMd || '';
      systemMapSections = ctx.systemMap
        ? getRelevantSystemMapSections(ctx.systemMap, filePaths)
        : '';
      const matchedADRs = getRelevantADRs(ctx.adrs, filePaths, entityNames ?? []);
      relevantADRs = matchedADRs.map(
        (adr) => `**${adr.title}** (${adr.status}): ${adr.decision}`,
      );
    }
  }

  const blastRadius = getBlastRadius(graph, filePaths, 2);

  return NextResponse.json({
    systemMapSections,
    relevantADRs,
    claudeMdSections,
    blastRadius: {
      files: blastRadius.affectedFiles,
      entityCount: blastRadius.affectedEntities.length,
    },
  });
}
