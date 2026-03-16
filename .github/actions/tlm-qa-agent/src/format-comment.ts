// .github/actions/tlm-qa-agent/src/format-comment.ts

export interface SmokeCheckResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  message?: string;
}

export interface SmokeTestResult {
  passed: boolean;
  checks: SmokeCheckResult[];
  durationMs?: number;
}

export interface CriterionResult {
  criterion: string;
  status: 'pass' | 'fail' | 'skip';
  evidence: string;
}

export interface QAReport {
  previewUrl: string;
  smokeTest: SmokeTestResult;
  criteriaResults: CriterionResult[];
  verdict: 'pass' | 'advisory-pass' | 'issues-found' | 'failed';
  verdictSummary: string;
}

function statusEmoji(status: 'pass' | 'fail' | 'skip' | string): string {
  switch (status) {
    case 'pass': return '✅';
    case 'fail': return '❌';
    case 'skip': return '⚠️';
    default: return '⚠️';
  }
}

function verdictEmoji(verdict: QAReport['verdict']): string {
  switch (verdict) {
    case 'pass': return '✅';
    case 'advisory-pass': return '⚠️';
    case 'issues-found': return '❌';
    case 'failed': return '❌';
    default: return '⚠️';
  }
}

function verdictLabel(verdict: QAReport['verdict']): string {
  switch (verdict) {
    case 'pass': return 'Pass';
    case 'advisory-pass': return 'Advisory Pass';
    case 'issues-found': return 'Issues Found';
    case 'failed': return 'Failed';
    default: return 'Unknown';
  }
}

export function computeVerdict(
  criteriaResults: QAReport['criteriaResults']
): { verdict: QAReport['verdict']; summary: string } {
  if (criteriaResults.length === 0) {
    return {
      verdict: 'failed',
      summary: 'No criteria evaluated.',
    };
  }

  const passed = criteriaResults.filter((r) => r.status === 'pass').length;
  const failed = criteriaResults.filter((r) => r.status === 'fail').length;
  const skipped = criteriaResults.filter((r) => r.status === 'skip').length;
  const total = criteriaResults.length;

  if (failed > 0) {
    return {
      verdict: 'issues-found',
      summary: `${passed}/${total} criteria verified, ${skipped} not testable. ${failed} failure(s) found.`,
    };
  }

  if (skipped > 0) {
    return {
      verdict: 'advisory-pass',
      summary: `${passed}/${total} criteria verified, ${skipped} not testable.`,
    };
  }

  return {
    verdict: 'pass',
    summary: `${passed}/${total} criteria verified, 0 not testable.`,
  };
}

export function formatPRComment(report: QAReport): string {
  const emoji = verdictEmoji(report.verdict);
  const label = verdictLabel(report.verdict);

  const lines: string[] = [];

  // Header
  lines.push(`## ${emoji} QA Agent Report — ${label}`);
  lines.push('');

  // Preview URL
  lines.push(`**Preview:** [${report.previewUrl}](${report.previewUrl})`);
  lines.push('');

  // Smoke Test section
  lines.push('### 🔍 Smoke Test');
  lines.push('');

  if (report.smokeTest.checks.length === 0) {
    lines.push('_No smoke test checks recorded._');
  } else {
    for (const check of report.smokeTest.checks) {
      const icon = statusEmoji(check.status);
      const detail = check.message ? ` — ${check.message}` : '';
      lines.push(`- ${icon} **${check.name}**${detail}`);
    }
  }

  if (report.smokeTest.durationMs !== undefined) {
    lines.push('');
    lines.push(`_Completed in ${report.smokeTest.durationMs}ms_`);
  }

  lines.push('');

  // Acceptance Criteria section
  lines.push('### ✔️ Acceptance Criteria Verification');
  lines.push('');

  if (report.criteriaResults.length === 0) {
    lines.push('_No acceptance criteria evaluated._');
  } else {
    for (const cr of report.criteriaResults) {
      const icon = statusEmoji(cr.status);
      lines.push(`- ${icon} **${cr.criterion}**`);
      if (cr.evidence) {
        lines.push(`  - _${cr.evidence}_`);
      }
    }
  }

  lines.push('');

  // Verdict line with counts
  const passed = report.criteriaResults.filter((r) => r.status === 'pass').length;
  const skipped = report.criteriaResults.filter((r) => r.status === 'skip').length;
  const total = report.criteriaResults.length;

  lines.push(
    `**Verdict:** ${emoji} ${label} — ${passed}/${total} criteria verified, ${skipped} not testable`
  );
  lines.push('');

  // Verdict summary if provided
  if (report.verdictSummary) {
    lines.push(`> ${report.verdictSummary}`);
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('> ⚠️ Advisory Mode — QA Agent results are informational only');

  return lines.join('\n');
}
