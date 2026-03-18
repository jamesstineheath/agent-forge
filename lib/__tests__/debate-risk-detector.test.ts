import { describe, it, expect } from 'vitest';
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
    maxRounds: 3,
    confidenceThreshold: 0.7,
    model: 'claude-opus-4-6',
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
      maxRounds: 3,
      confidenceThreshold: 0.7,
      model: 'claude-opus-4-6',
    };
    expect(shouldRunDebate('low', allEnabled)).toBe(true);
    expect(shouldRunDebate('medium', allEnabled)).toBe(true);
    expect(shouldRunDebate('high', allEnabled)).toBe(true);
  });

  it('returns false for all levels when none are enabled', () => {
    const noneEnabled: DebateConfig = {
      enabledForRiskLevels: [],
      maxRounds: 3,
      confidenceThreshold: 0.7,
      model: 'claude-opus-4-6',
    };
    expect(shouldRunDebate('low', noneEnabled)).toBe(false);
    expect(shouldRunDebate('medium', noneEnabled)).toBe(false);
    expect(shouldRunDebate('high', noneEnabled)).toBe(false);
  });
});
