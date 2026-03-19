#!/usr/bin/env node
/**
 * run-qa.ts — QA Agent orchestrator
 *
 * Tiered execution: Tier 0 smoke → Tier 1 Playwright baseline →
 * Tier 2 API health → Tier 3 acceptance criteria verification.
 * Advisory mode — always exits 0.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import { Octokit } from '@octokit/rest';
import { runSmokeTest } from './src/smoke-test.js';
import { parseAcceptanceCriteria, ParsedCriterion } from './src/parse-criteria.js';
import {
  formatPRComment,
  computeVerdict,
  QAReport,
  SmokeTestResult,
  CriterionResult,
} from './src/format-comment.js';
import { logToActionLedger, QAActionLedgerEntry } from './src/action-ledger.js';

const startTime = Date.now();

// --- Environment ---
const previewUrl = process.env.PREVIEW_URL || '';
const prNumber = process.env.PR_NUMBER || '';
const repo = process.env.GITHUB_REPOSITORY || '';
const runId = process.env.GITHUB_RUN_ID || 'unknown';
const githubToken = process.env.GITHUB_TOKEN || '';
const qaToken = process.env.QA_BYPASS_SECRET || '';

console.log('[QA Agent] Starting orchestrator');
console.log('[QA Agent] preview-url:', previewUrl);
console.log('[QA Agent] pr-number:  ', prNumber);

// --- Tier 0: Smoke Tests ---
console.log('\n[QA Agent] === Tier 0: Smoke Tests ===');

const smokeRoutes = ['/', '/agents', '/work-items', '/pipeline', '/settings'];
const smokeResult = await runSmokeTest(previewUrl, smokeRoutes, qaToken);

const smokeTestForReport: SmokeTestResult = {
  passed: smokeResult.overallPassed,
  checks: [
    {
      name: 'Root (/) reachable',
      status: smokeResult.rootCheck.passed ? 'pass' : 'fail',
      message: smokeResult.rootCheck.error || `HTTP ${smokeResult.rootCheck.statusCode}`,
    },
    ...smokeResult.routeChecks.map((rc) => ({
      name: `Route ${rc.route}`,
      status: (rc.passed ? 'pass' : 'fail') as 'pass' | 'fail',
      message: rc.error || `HTTP ${rc.statusCode}`,
    })),
  ],
  durationMs: Date.now() - startTime,
};

console.log('[QA Agent] Smoke tests:', smokeResult.overallPassed ? 'PASSED' : 'FAILED');

if (!smokeResult.overallPassed) {
  console.log('[QA Agent] Smoke tests failed — skipping Playwright tiers');
}

// --- Tier 1 & 2: Playwright Tests ---
let playwrightPassed = false;
let playwrightResults: Array<{ title: string; status: string }> = [];

if (smokeResult.overallPassed) {
  console.log('\n[QA Agent] === Tier 1 & 2: Playwright Tests ===');
  try {
    execSync('npx playwright test --reporter=json', {
      cwd: process.cwd(),
      stdio: 'pipe',
      env: {
        ...process.env,
        PLAYWRIGHT_JSON_OUTPUT_NAME: 'qa-results.json',
      },
    });
    playwrightPassed = true;
    console.log('[QA Agent] Playwright tests: PASSED');
  } catch (err: unknown) {
    console.log('[QA Agent] Playwright tests: FAILED (or partially failed)');
    // Playwright exits non-zero on test failures — that's expected in advisory mode
  }

  // Parse results
  const resultsPath = 'qa-results.json';
  if (fs.existsSync(resultsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
      if (raw.suites) {
        for (const suite of raw.suites) {
          for (const spec of suite.specs || []) {
            for (const test of spec.tests || []) {
              playwrightResults.push({
                title: spec.title,
                status: test.status,
              });
            }
          }
        }
      }
    } catch {
      console.log('[QA Agent] Could not parse qa-results.json');
    }
  }
}

// --- Tier 3: Acceptance Criteria ---
console.log('\n[QA Agent] === Tier 3: Acceptance Criteria ===');

let criteriaResults: CriterionResult[] = [];

if (prNumber && repo && githubToken) {
  const [owner, repoName] = repo.split('/');
  const octokit = new Octokit({ auth: githubToken });

  try {
    const { data: pr } = await octokit.pulls.get({
      owner,
      repo: repoName,
      pull_number: parseInt(prNumber, 10),
    });

    const prDescription = pr.body || '';
    const parsedCriteria: ParsedCriterion[] = parseAcceptanceCriteria(prDescription);

    console.log(`[QA Agent] Found ${parsedCriteria.length} acceptance criteria`);

    for (const criterion of parsedCriteria) {
      if (criterion.category === 'not-verifiable') {
        criteriaResults.push({
          criterion: criterion.criterion,
          status: 'skip',
          evidence: 'Not automatically verifiable',
        });
        continue;
      }

      if (criterion.category === 'http') {
        // Extract route from criterion text
        const routeMatch = criterion.criterion.match(/\/api\/[^\s,)]+/);
        if (routeMatch && previewUrl) {
          try {
            const url = `${previewUrl.replace(/\/$/, '')}${routeMatch[0]}`;
            const res = await fetch(url, {
              headers: { 'X-QA-Agent-Token': qaToken },
              signal: AbortSignal.timeout(10000),
            });
            if (res.status >= 500) {
              criteriaResults.push({
                criterion: criterion.criterion,
                status: 'fail',
                evidence: `HTTP ${res.status} — server error`,
              });
            } else {
              criteriaResults.push({
                criterion: criterion.criterion,
                status: 'pass',
                evidence: `HTTP ${res.status} — endpoint responsive`,
              });
            }
          } catch (err: unknown) {
            criteriaResults.push({
              criterion: criterion.criterion,
              status: 'fail',
              evidence: err instanceof Error ? err.message : 'Fetch failed',
            });
          }
        } else {
          criteriaResults.push({
            criterion: criterion.criterion,
            status: 'skip',
            evidence: 'Could not extract route from criterion',
          });
        }
        continue;
      }

      if (criterion.category === 'playwright') {
        // Match against Playwright results by looking for route keywords
        const routeKeywords = ['/agents', '/work-items', '/pipeline', '/settings', '/'];
        const matchedRoute = routeKeywords.find((r) =>
          criterion.criterion.toLowerCase().includes(r.replace('/', ''))
        );

        if (matchedRoute && playwrightResults.length > 0) {
          const relatedTests = playwrightResults.filter((t) =>
            t.title.toLowerCase().includes(matchedRoute.replace('/', ''))
          );
          if (relatedTests.length > 0) {
            const allPassed = relatedTests.every((t) => t.status === 'expected');
            criteriaResults.push({
              criterion: criterion.criterion,
              status: allPassed ? 'pass' : 'fail',
              evidence: allPassed
                ? `Playwright tests passed for ${matchedRoute}`
                : `Playwright test failures detected for ${matchedRoute}`,
            });
          } else {
            criteriaResults.push({
              criterion: criterion.criterion,
              status: 'skip',
              evidence: 'No matching Playwright test found',
            });
          }
        } else {
          criteriaResults.push({
            criterion: criterion.criterion,
            status: 'skip',
            evidence: 'No Playwright results available',
          });
        }
        continue;
      }
    }
  } catch (err: unknown) {
    console.log('[QA Agent] Could not fetch PR description:', err instanceof Error ? err.message : err);
  }
} else {
  console.log('[QA Agent] Missing PR_NUMBER, GITHUB_REPOSITORY, or GITHUB_TOKEN — skipping criteria');
}

// --- Build Report & Post Comment ---
console.log('\n[QA Agent] === Generating Report ===');

const { verdict, summary } = criteriaResults.length > 0
  ? computeVerdict(criteriaResults)
  : { verdict: smokeResult.overallPassed ? 'pass' as const : 'issues-found' as const, summary: 'Smoke test only — no acceptance criteria found.' };

const report: QAReport = {
  previewUrl,
  smokeTest: smokeTestForReport,
  criteriaResults,
  verdict,
  verdictSummary: summary,
};

const commentBody = formatPRComment(report);
console.log('[QA Agent] Report generated');

// Post or update PR comment
if (prNumber && repo && githubToken) {
  const [owner, repoName] = repo.split('/');
  const octokit = new Octokit({ auth: githubToken });
  const prNum = parseInt(prNumber, 10);
  const commentMarker = '## ✅ QA Agent Report';
  const commentMarkerAlt = '## ❌ QA Agent Report';
  const commentMarkerWarn = '## ⚠️ QA Agent Report';

  try {
    // Search for existing QA comment
    const { data: comments } = await octokit.issues.listComments({
      owner,
      repo: repoName,
      issue_number: prNum,
      per_page: 100,
    });

    const existingComment = comments.find(
      (c) =>
        c.body?.includes(commentMarker) ||
        c.body?.includes(commentMarkerAlt) ||
        c.body?.includes(commentMarkerWarn) ||
        c.body?.includes('## 🤖 QA Agent Report')
    );

    if (existingComment) {
      await octokit.issues.updateComment({
        owner,
        repo: repoName,
        comment_id: existingComment.id,
        body: commentBody,
      });
      console.log('[QA Agent] Updated existing PR comment');
    } else {
      await octokit.issues.createComment({
        owner,
        repo: repoName,
        issue_number: prNum,
        body: commentBody,
      });
      console.log('[QA Agent] Posted new PR comment');
    }
  } catch (err: unknown) {
    console.error('[QA Agent] Failed to post PR comment:', err instanceof Error ? err.message : err);
  }
}

// --- Structured stdout ---
const structuredResult = {
  tier0_smoke: {
    passed: smokeResult.overallPassed,
    checks: smokeTestForReport.checks.length,
  },
  tier1_playwright: {
    passed: playwrightPassed,
    tests: playwrightResults.length,
  },
  tier3_criteria: {
    total: criteriaResults.length,
    passed: criteriaResults.filter((r) => r.status === 'pass').length,
    failed: criteriaResults.filter((r) => r.status === 'fail').length,
    skipped: criteriaResults.filter((r) => r.status === 'skip').length,
  },
  verdict,
  durationMs: Date.now() - startTime,
};

console.log('\n[QA Agent] === Structured Results ===');
console.log(JSON.stringify(structuredResult, null, 2));

// --- Ledger (skip git push for Tier 1) ---
const ledgerEntry: QAActionLedgerEntry = {
  timestamp: new Date().toISOString(),
  agentType: 'qa-agent',
  prNumber: prNumber ? parseInt(prNumber, 10) : null,
  repo,
  outcome: verdict === 'pass' || verdict === 'advisory-pass' ? 'pass' : 'fail',
  smokeTestResults: smokeTestForReport.checks.map((c) => ({
    name: c.name,
    passed: c.status === 'pass',
    durationMs: 0,
    error: c.status === 'fail' ? c.message : undefined,
  })),
  acceptanceCriteriaVerdicts: criteriaResults.map((r) => ({
    criterion: r.criterion,
    verdict: r.status,
    evidence: r.evidence,
  })),
  totalDurationMs: Date.now() - startTime,
  deployUrl: previewUrl || null,
  runId,
  assessedOutcome: null,
};

// Log to stdout only — skip git push for Tier 1
console.log('\n[QA Agent] Ledger entry (stdout only, no git push):');
console.log(JSON.stringify(ledgerEntry, null, 2));

console.log('\n[QA Agent] Done — exiting cleanly (advisory mode)');
process.exit(0);
