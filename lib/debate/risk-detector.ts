import type { DebateConfig } from './types';

export type RiskLevel = 'low' | 'medium' | 'high';

// Re-export DebateConfig for convenience
export type { DebateConfig } from './types';

/**
 * Categorized file pattern arrays for risk classification.
 * Patterns are matched as substrings of file paths.
 */
export const RISK_PATTERNS = {
  high: {
    pathSubstrings: [
      '.github/',
      'auth',
      'security',
      'credential',
      'secret',
      'token',
    ],
    storageSubstrings: [
      'lib/storage',
      'lib/database',
      'lib/db',
      'storage.ts',
      'database.ts',
    ],
  },
  medium: {
    pathSubstrings: [
      'app/api/',
      'lib/',
    ],
  },
  low: {
    docExtensions: ['.md', '.mdx'],
    testPatterns: ['.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx', '__tests__/'],
  },
} as const;

/**
 * Count the number of changed lines in a diff string.
 * Counts lines starting with '+' or '-' (excluding diff headers '+++' / '---').
 */
function countDiffLines(diff: string): number {
  return diff
    .split('\n')
    .filter(
      (line) =>
        (line.startsWith('+') || line.startsWith('-')) &&
        !line.startsWith('+++') &&
        !line.startsWith('---')
    ).length;
}

/**
 * Get the set of distinct top-level directories from changed files.
 */
function getTopLevelDirs(filesChanged: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const file of filesChanged) {
    const parts = file.split('/');
    if (parts.length > 1) {
      dirs.add(parts[0]);
    }
  }
  return dirs;
}

/**
 * Determine the risk level of a PR based on diff characteristics.
 * Evaluation order: HIGH → MEDIUM → LOW → default MEDIUM
 */
export function detectPRRiskLevel(params: {
  diff: string;
  filesChanged: string[];
  prLabels?: string[];
}): RiskLevel {
  const { diff, filesChanged } = params;
  const lineCount = countDiffLines(diff);

  // --- HIGH risk checks ---

  const hasWorkflowFiles = filesChanged.some((f) =>
    f.includes('.github/')
  );
  if (hasWorkflowFiles) return 'high';

  const hasHighRiskPath = filesChanged.some((f) => {
    const lower = f.toLowerCase();
    return RISK_PATTERNS.high.pathSubstrings
      .filter((p) => p !== '.github/')
      .some((pattern) => lower.includes(pattern.toLowerCase()));
  });
  if (hasHighRiskPath) return 'high';

  const hasStorageFile = filesChanged.some((f) => {
    const lower = f.toLowerCase();
    return RISK_PATTERNS.high.storageSubstrings.some((pattern) =>
      lower.includes(pattern.toLowerCase())
    );
  });
  if (hasStorageFile) return 'high';

  if (lineCount > 500) return 'high';

  // --- MEDIUM risk checks ---

  const hasApiRoutes = filesChanged.some((f) => f.includes('app/api/'));
  if (hasApiRoutes) return 'medium';

  const topDirs = getTopLevelDirs(filesChanged);
  if (topDirs.size >= 3) return 'medium';

  const isTestFile = (f: string) =>
    RISK_PATTERNS.low.testPatterns.some((pattern) => f.includes(pattern));
  const hasCoreLibFiles = filesChanged.some((f) => f.includes('lib/') && !isTestFile(f));
  if (hasCoreLibFiles && lineCount > 50) return 'medium';

  if (lineCount > 200) return 'medium';

  // --- LOW risk checks ---

  const allDocs =
    filesChanged.length > 0 &&
    filesChanged.every((f) =>
      RISK_PATTERNS.low.docExtensions.some((ext) => f.endsWith(ext))
    );
  if (allDocs) return 'low';

  const allTests =
    filesChanged.length > 0 &&
    filesChanged.every((f) =>
      RISK_PATTERNS.low.testPatterns.some(
        (pattern) => f.includes(pattern)
      )
    );
  if (allTests) return 'low';

  if (lineCount < 50) return 'low';

  if (filesChanged.length === 1 && lineCount < 50) return 'low';

  // Default
  return 'medium';
}

/**
 * Determine whether the debate system should run for a given risk level.
 */
export function shouldRunDebate(
  riskLevel: RiskLevel,
  config: DebateConfig
): boolean {
  return config.enabledForRiskLevels.includes(riskLevel);
}
