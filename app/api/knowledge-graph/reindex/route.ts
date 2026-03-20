import { NextRequest, NextResponse } from 'next/server';
import { validateAuth } from '@/lib/api-auth';
import { fullIndex, incrementalIndex } from '@/lib/knowledge-graph/indexer';
import { listRepos, getRepo } from '@/lib/repos';

export async function POST(req: NextRequest) {
  const authError = await validateAuth(req, 'AGENT_FORGE_API_SECRET');
  if (authError) return authError;

  const body = await req.json();
  const { repo, mode, changedFiles, seedAll } = body as {
    repo?: string;
    mode?: 'full' | 'incremental';
    changedFiles?: string[];
    seedAll?: boolean;
  };

  // Seed all registered repos
  if (seedAll) {
    const repoIndex = await listRepos();
    const results: Array<{ repo: string; entityCount: number; durationMs: number }> = [];

    for (const entry of repoIndex) {
      const repoConfig = await getRepo(entry.id);
      if (!repoConfig) continue;

      const start = Date.now();
      const result = await fullIndex(repoConfig.fullName);
      results.push({
        repo: repoConfig.fullName,
        entityCount: result.entityCount,
        durationMs: Date.now() - start,
      });
    }

    return NextResponse.json({ seeded: results });
  }

  if (!repo) {
    return NextResponse.json({ error: 'repo is required' }, { status: 400 });
  }

  // Resolve short name to full name if needed
  let fullName = repo;
  if (!repo.includes('/')) {
    const repoIndex = await listRepos();
    const entry = repoIndex.find(
      (r) => r.id === repo || r.fullName.endsWith(`/${repo}`),
    );
    if (entry) fullName = entry.fullName;
  }

  const start = Date.now();

  if (mode === 'incremental' && changedFiles?.length) {
    const result = await incrementalIndex(fullName, changedFiles);
    return NextResponse.json({
      entityCount: result.entitiesUpdated,
      relationshipCount: 0,
      durationMs: Date.now() - start,
    });
  }

  const result = await fullIndex(fullName);
  return NextResponse.json({
    entityCount: result.entityCount,
    relationshipCount: 0,
    durationMs: Date.now() - start,
  });
}
