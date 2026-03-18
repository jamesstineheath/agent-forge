# Agent Forge -- Add risk level detection utility for PRs

## Metadata
- **Branch:** `feat/add-pr-risk-level-detection-utility`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/debate/risk-detector.ts, lib/__tests__/debate-risk-detector.test.ts

## Context

Agent Forge includes a debate system for evaluating PRs. The debate system needs to decide whether to activate based on the risk level of a PR — low-risk PRs (docs, tests, single-file style changes) should skip debate to avoid unnecessary overhead, while medium/high-risk PRs (auth changes, workflow files, large diffs, API routes) should trigger debate.

This utility is a pure function module with no external dependencies. The concurrent work item "Add debate session persistence to storage" is working in `lib/debate/storage.ts` — this task only touches `lib/debate/risk-detector.ts`, so there is no file overlap.

The existing pattern for debate types lives in `lib/debate/` (see the merged PR `feat: add debate session persistence to storage`). Follow the same module structure. Tests follow the pattern seen in `lib/__tests__/knowledge-graph-*.test.ts`.

A `DebateConfig` type likely needs to be referenced — if it doesn't yet exist in `lib/debate/types.ts` or similar, define a minimal inline type in this file and export it, so downstream consumers can import it.

## Requirements

1. Create `lib/debate/risk-detector.ts` exporting `RISK_PATTERNS`, `detectPRRiskLevel`, and `shouldRunDebate`
2. `RISK_PATTERNS` must be an exported `const` object with categorized arrays of file glob/substring patterns (high, medium, low categories)
3. `detectPRRiskLevel(params: { diff: string, filesChanged: string[], prLabels?: string[] })` returns `'low' | 'medium' | 'high'`
4. Risk heuristics applied in priority order (high → medium → low):
   - **HIGH**: any file matching `.github/` path, auth-related filenames (`auth`, `security`, `credential`, `secret`, `token` in path), storage/database layer files (`storage`, `database`, `db` in path under `lib/`), or diff line count > 500
   - **MEDIUM**: any file matching `app/api/` routes, any file under `lib/` (core library), changes spanning multiple subsystems (files in 3+ distinct top-level directories), or diff line count > 200
   - **LOW**: all changed files are `*.md`, all changed files are test files (`*.test.ts`, `*.spec.ts`, `__tests__/`), single file changed with < 50 diff lines, or diff line count < 50
5. If no LOW condition matches after failing HIGH and MEDIUM checks, default to `'medium'`
6. `shouldRunDebate(riskLevel: 'low' | 'medium' | 'high', config: DebateConfig): boolean` returns `true` if `riskLevel` is included in `config.enabledForRiskLevels`
7. Export a `DebateConfig` interface (or re-export if it already exists) with at minimum `enabledForRiskLevels: Array<'low' | 'medium' | 'high'>`
8. Write unit tests in `lib/__tests__/debate-risk-detector.test.ts` covering all acceptance criteria

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/add-pr-risk-level-detection-utility
```

### Step 1: Check for existing DebateConfig type

```bash
# Check if DebateConfig or debate types already exist
find lib/debate -type f | sort
grep -r "DebateConfig" lib/ --include="*.ts" -l 2>/dev/null || echo "Not found"
```

If `DebateConfig` already exists in a debate types file, import from it. If not, define it in `risk-detector.ts` and export it.

### Step 2: Create `lib/debate/risk-detector.ts`

```typescript
// lib/debate/risk-detector.ts

export type RiskLevel = 'low' | 'medium' | 'high';

export interface DebateConfig {
  enabledForRiskLevels: RiskLevel[];
  // extend as needed by other debate modules
}

/**
 * Categorized file pattern arrays for risk classification.
 * Patterns are matched as substrings of file paths.
 * Extend these arrays to add new patterns without changing logic.
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
 * e.g. ['lib/foo.ts', 'app/api/bar.ts', 'lib/baz.ts'] → ['lib', 'app']
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

  // Workflow files
  const hasWorkflowFiles = filesChanged.some((f) =>
    f.includes('.github/')
  );
  if (hasWorkflowFiles) return 'high';

  // Auth / security / credential / secret / token in path
  const hasHighRiskPath = filesChanged.some((f) => {
    const lower = f.toLowerCase();
    return RISK_PATTERNS.high.pathSubstrings
      .filter((p) => p !== '.github/') // already checked above
      .some((pattern) => lower.includes(pattern.toLowerCase()));
  });
  if (hasHighRiskPath) return 'high';

  // Storage / database layer
  const hasStorageFile = filesChanged.some((f) => {
    const lower = f.toLowerCase();
    return RISK_PATTERNS.high.storageSubstrings.some((pattern) =>
      lower.includes(pattern.toLowerCase())
    );
  });
  if (hasStorageFile) return 'high';

  // Large diff
  if (lineCount > 500) return 'high';

  // --- MEDIUM risk checks ---

  // API routes
  const hasApiRoutes = filesChanged.some((f) => f.includes('app/api/'));
  if (hasApiRoutes) return 'medium';

  // Changes span 3+ distinct top-level directories (multiple subsystems)
  const topDirs = getTopLevelDirs(filesChanged);
  if (topDirs.size >= 3) return 'medium';

  // Core library files
  const hasCoreLibFiles = filesChanged.some((f) => f.includes('lib/'));
  if (hasCoreLibFiles && lineCount > 50) return 'medium';

  // Diff > 200 lines
  if (lineCount > 200) return 'medium';

  // --- LOW risk checks ---

  // Documentation-only (all files are .md / .mdx)
  const allDocs =
    filesChanged.length > 0 &&
    filesChanged.every((f) =>
      RISK_PATTERNS.low.docExtensions.some((ext) => f.endsWith(ext))
    );
  if (allDocs) return 'low';

  // Test-only changes
  const allTests =
    filesChanged.length > 0 &&
    filesChanged.every((f) =>
      RISK_PATTERNS.low.testPatterns.some(
        (pattern) => f.includes(pattern)
      )
    );
  if (allTests) return 'low';

  // Small diff (< 50 lines)
  if (lineCount < 50) return 'low';

  // Single file, small diff
  if (filesChanged.length === 1 && lineCount < 50) return 'low';

  // Default
  return 'medium';
}

/**
 * Determine whether the debate system should run for a given risk level,
 * based on the configured enabled risk levels.
 */
export function shouldRunDebate(
  riskLevel: RiskLevel,
  config: DebateConfig
): boolean {
  return config.enabledForRiskLevels.includes(riskLevel);
}
```

### Step 3: Create unit tests in `lib/__tests__/debate-risk-detector.test.ts`

```typescript
// lib/__tests__/debate-risk-detector.test.ts

import {
  detectPRRiskLevel,
  shouldRunDebate,
  RISK_PATTERNS,
  DebateConfig,
} from '../debate/risk-detector';

// Helper: generate a fake diff with N changed lines
function makeDiff(lines: number, type: '+' | '-' = '+'): string {
  return Array.from({ length: lines }, (_, i) => `${type} line ${i}`).join('\n');
}

describe('RISK_PATTERNS', () => {
  it('is exported and contains high, medium, low categories', () => {
    expect(RISK_PATTERNS).toBeDefined();
    expect(RISK_PATTERNS.high).toBeDefined();
    expect(RISK_PATTERNS.medium).toBeDefined();
    expect(RISK_PATTERNS.low).toBeDefined();
  });

  it('high category contains .github/ pattern', () => {
    expect(RISK_PATTERNS.high.pathSubstrings).toContain('.github/');
  });

  it('low category contains doc extensions', () => {
    expect(RISK_PATTERNS.low.docExtensions).toContain('.md');
  });
});

describe('detectPRRiskLevel — HIGH', () => {
  it('returns high for .github/ workflow files', () => {
    expect(
      detectPRRiskLevel({
        diff: makeDiff(10),
        filesChanged: ['.github/workflows/ci.yml'],
      })
    ).toBe('high');
  });

  it('returns high for auth-related files', () => {
    expect(
      detectPRRiskLevel({
        diff: makeDiff(10),
        filesChanged: ['lib/auth.ts'],
      })
    ).toBe('high');
  });

  it('returns high for security-related files', () => {
    expect(
      detectPRRiskLevel({
        diff: makeDiff(10),
        filesChanged: ['lib/security-utils.ts'],
      })
    ).toBe('high');
  });

  it('returns high for storage layer files', () => {
    expect(
      detectPRRiskLevel({
        diff: makeDiff(10),
        filesChanged: ['lib/storage.ts'],
      })
    ).toBe('high');
  });

  it('returns high when diff exceeds 500 lines', () => {
    expect(
      detectPRRiskLevel({
        diff: makeDiff(501),
        filesChanged: ['app/some-component.tsx'],
      })
    ).toBe('high');
  });
});

describe('detectPRRiskLevel — MEDIUM', () => {
  it('returns medium for API route changes', () => {
    expect(
      detectPRRiskLevel({
        diff: makeDiff(100),
        filesChanged: ['app/api/work-items/route.ts'],
      })
    ).toBe('medium');
  });

  it('returns medium for lib/ files with >50 lines changed', () => {
    expect(
      detectPRRiskLevel({
        diff: makeDiff(60),
        filesChanged: ['lib/orchestrator.ts'],
      })
    ).toBe('medium');
  });

  it('returns medium for changes spanning 3+ top-level dirs', () => {
    expect(
      detectPRRiskLevel({
        diff: makeDiff(30),
        filesChanged: ['lib/foo.ts', 'app/page.tsx', 'components/bar.tsx'],
      })
    ).toBe('medium');
  });

  it('returns medium for diff >200 lines without other triggers', () => {
    expect(
      detectPRRiskLevel({
        diff: makeDiff(250),
        filesChanged: ['app/some-page.tsx'],
      })
    ).toBe('medium');
  });
});

describe('detectPRRiskLevel — LOW', () => {
  it('returns low for documentation-only changes (*.md files only)', () => {
    expect(
      detectPRRiskLevel({
        diff: makeDiff(100),
        filesChanged: ['README.md', 'docs/SYSTEM_MAP.md'],
      })
    ).toBe('low');
  });

  it('returns low for test-only changes', () => {
    expect(
      detectPRRiskLevel({
        diff: makeDiff(80),
        filesChanged: [
          'lib/__tests__/foo.test.ts',
          'lib/__tests__/bar.spec.ts',
        ],
      })
    ).toBe('low');
  });

  it('returns low for diff < 50 lines', () => {
    expect(
      detectPRRiskLevel({
        diff: makeDiff(30),
        filesChanged: ['app/some-component.tsx'],
      })
    ).toBe('low');
  });

  it('returns low for single-file style change with < 50 lines', () => {
    expect(
      detectPRRiskLevel({
        diff: makeDiff(20),
        filesChanged: ['components/ui/button.tsx'],
      })
    ).toBe('low');
  });
});

describe('shouldRunDebate', () => {
  const config: DebateConfig = {
    enabledForRiskLevels: ['medium', 'high'],
  };

  it('returns true when riskLevel is in enabledForRiskLevels', () => {
    expect(shouldRunDebate('medium', config)).toBe(true);
    expect(shouldRunDebate('high', config)).toBe(true);
  });

  it('returns false when riskLevel is not in enabledForRiskLevels', () => {
    expect(shouldRunDebate('low', config)).toBe(false);
  });

  it('returns true for all levels when all are enabled', () => {
    const allEnabled: DebateConfig = {
      enabledForRiskLevels: ['low', 'medium', 'high'],
    };
    expect(shouldRunDebate('low', allEnabled)).toBe(true);
    expect(shouldRunDebate('medium', allEnabled)).toBe(true);
    expect(shouldRunDebate('high', allEnabled)).toBe(true);
  });

  it('returns false for all levels when none are enabled', () => {
    const noneEnabled: DebateConfig = { enabledForRiskLevels: [] };
    expect(shouldRunDebate('low', noneEnabled)).toBe(false);
    expect(shouldRunDebate('medium', noneEnabled)).toBe(false);
    expect(shouldRunDebate('high', noneEnabled)).toBe(false);
  });
});
```

### Step 4: Check for existing DebateConfig conflicts and resolve imports

```bash
# If DebateConfig is already defined elsewhere in lib/debate/, adjust the import
# in risk-detector.ts to import from that file instead of re-declaring it.
grep -r "DebateConfig" lib/ --include="*.ts" 2>/dev/null
grep -r "enabledForRiskLevels" lib/ --include="*.ts" 2>/dev/null
```

If a `DebateConfig` type already exists with `enabledForRiskLevels`, import from that file and remove the duplicate definition in `risk-detector.ts`. If the existing `DebateConfig` does not have `enabledForRiskLevels`, add the field to the existing interface rather than creating a conflicting type.

### Step 5: Verification

```bash
# Type check
npx tsc --noEmit

# Run the new tests
npx jest lib/__tests__/debate-risk-detector.test.ts --no-coverage

# Run full test suite to ensure no regressions
npm test -- --passWithNoTests
```

Expected: all debate-risk-detector tests pass, no TypeScript errors, no regressions.

### Step 6: Commit, push, open PR

```bash
git add lib/debate/risk-detector.ts lib/__tests__/debate-risk-detector.test.ts
git commit -m "feat: add PR risk level detection utility for debate system"
git push origin feat/add-pr-risk-level-detection-utility
gh pr create \
  --title "feat: add PR risk level detection utility for debate system" \
  --body "## Summary

Adds \`lib/debate/risk-detector.ts\` with two exported functions and a configurable \`RISK_PATTERNS\` object:

- \`detectPRRiskLevel({ diff, filesChanged, prLabels? })\` — classifies a PR as \`low\`, \`medium\`, or \`high\` risk based on file paths and diff size
- \`shouldRunDebate(riskLevel, config)\` — checks whether riskLevel is in \`config.enabledForRiskLevels\`
- \`RISK_PATTERNS\` — exported const with categorized file pattern arrays (easy extension point)

### Risk Heuristics (evaluated high → medium → low)
| Level | Triggers |
|-------|---------|
| HIGH | .github/ files, auth/security/credential/secret/token paths, storage layer files, >500 diff lines |
| MEDIUM | app/api/ routes, lib/ files (>50 lines), 3+ subsystems touched, >200 diff lines |
| LOW | docs-only (*.md), test-only, <50 diff lines |

### Tests
Full unit test coverage in \`lib/__tests__/debate-risk-detector.test.ts\` covering all acceptance criteria.

### No file conflicts
Concurrent work item (debate session persistence) touches \`lib/debate/storage.ts\` only — no overlap."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/add-pr-risk-level-detection-utility
FILES CHANGED: [lib/debate/risk-detector.ts, lib/__tests__/debate-risk-detector.test.ts]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

### Escalation

If blocked on an unresolvable issue (e.g., conflicting `DebateConfig` type with incompatible shape, missing Jest config, or TypeScript project misconfiguration):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-pr-risk-level-detection-utility",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/debate/risk-detector.ts", "lib/__tests__/debate-risk-detector.test.ts"]
    }
  }'
```