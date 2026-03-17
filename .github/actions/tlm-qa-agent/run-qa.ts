#!/usr/bin/env ts-node
/**
 * run-qa.ts — QA Agent orchestrator
 *
 * Wires together smoke tests, acceptance criteria parsing, Claude-based
 * verification planning, HTTP checks, and PR comment posting.
 * Advisory mode: always exits 0.
 */

import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { Octokit } from '@octokit/rest';
import { runSmokeTest, SmokeTestResult as RawSmokeTestResult } from './src/smoke-test.js';
import { parseAcceptanceCriteria, extractFilePaths, extractHandoffTitle } from './src/parse-criteria.js';
import {
  formatPRComment,
  computeVerdict,
  QAReport,
  CriterionResult,
  SmokeTestResult as ReportSmokeTestResult,
  SmokeCheckResult,
} from './src/format-comment.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const QA_MARKER = '<!-- QA-AGENT-REPORT -->';
const HTTP_TIMEOUT_MS = 10_000;

/** Derive app routes from file paths (e.g. app/(app)/work-items/page.tsx -> /work-items) */
function deriveRoutesFromPaths(filePaths: string[]): string[] {
  const routes = new Set<string>();
  for (const fp of filePaths) {
    // App router pages: app/(group)/some/path/page.tsx -> /some/path
    const pageMatch = fp.match(/^app\/(?:\([^)]+\)\/)?(.+?)\/page\.[tj]sx?$/);
    if (pageMatch) {
      routes.add('/' + pageMatch[1].replace(/\([^)]+\)\//g, ''));
      continue;
    }
    // API routes: app/api/some/path/route.ts -> /api/some/path
    const apiMatch = fp.match(/^app\/(api\/.+?)\/route\.[tj]sx?$/);
    if (apiMatch) {
      routes.add('/' + apiMatch[1]);
    }
  }
  return Array.from(routes);
}

/** Convert raw smoke test result to report format */
function toReportSmokeTest(raw: RawSmokeTestResult, durationMs: number): ReportSmokeTestResult {
  const checks: SmokeCheckResult[] = [];

  checks.push({
    name: 'Root URL',
    status: raw.rootCheck.passed ? 'pass' : 'fail',
    message: raw.rootCheck.error ?? `HTTP ${raw.rootCheck.statusCode}`,
  });

  for (const rc of raw.routeChecks) {
    checks.push({
      name: `Route ${rc.route}`,
      status: rc.passed ? 'pass' : 'fail',
      message: rc.error ?? `HTTP ${rc.statusCode}`,
    });
  }

  return { passed: raw.overallPassed, checks, durationMs };
}

/** Make an HTTP request with timeout and QA token */
async function httpCheck(
  url: string,
  qaToken: string
): Promise<{ status: number; body: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'X-QA-Agent-Token': qaToken },
      signal: controller.signal,
    });
    const body = await res.text();
    return { status: res.status, body };
  } catch (err: unknown) {
    return {
      status: 0,
      body: '',
      error: err instanceof Error ? err.message : 'Unknown fetch error',
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Claude verification planning
// ---------------------------------------------------------------------------

interface ClaudeVerificationItem {
  criterion: string;
  category: 'http' | 'playwright' | 'not-verifiable';
  httpEndpoint?: string;
  expectedStatus?: number;
  expectedBodyContains?: string;
  skipReason?: string;
}

async function getClaudeVerificationPlan(
  anthropic: Anthropic,
  systemPrompt: string,
  prDiff: string,
  criteria: Array<{ criterion: string; category: string }>,
  previewUrl: string
): Promise<ClaudeVerificationItem[]> {
  const userMessage = `## PR Diff
\`\`\`
${prDiff.slice(0, 15000)}
\`\`\`

## Acceptance Criteria
${criteria.map((c, i) => `${i + 1}. ${c.criterion} (pre-classified: ${c.category})`).join('\n')}

## Preview URL
${previewUrl}

## Task
For each acceptance criterion above, return a JSON array where each element has:
- "criterion": the criterion text
- "category": one of "http", "playwright", or "not-verifiable"
- For "http" items: include "httpEndpoint" (full URL using the preview URL), "expectedStatus" (number), and optionally "expectedBodyContains" (string to check in response)
- For "not-verifiable" items: include "skipReason" (brief explanation)
- For "playwright" items: no extra fields needed (will be skipped in v1)

Return ONLY the JSON array, no other text.`;

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // Extract JSON from response (may be wrapped in markdown code fences)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.log('[QA Agent] Claude did not return parseable JSON, using pre-classifications');
    return criteria.map((c) => ({
      criterion: c.criterion,
      category: c.category as ClaudeVerificationItem['category'],
      skipReason: c.category === 'not-verifiable' ? 'Could not generate verification plan' : undefined,
    }));
  }

  return JSON.parse(jsonMatch[0]) as ClaudeVerificationItem[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Read environment variables
  const previewUrl = process.env.PREVIEW_URL || '';
  const prNumber = process.env.PR_NUMBER || '';
  const repo = process.env.REPO || '';
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || '';
  const qaBypassSecret = process.env.QA_BYPASS_SECRET || '';
  const githubToken = process.env.GITHUB_TOKEN || '';

  // 2. Validate inputs
  if (!previewUrl) {
    console.log('[QA Agent] PREVIEW_URL not set — skipping QA run');
    return;
  }
  if (!prNumber) {
    console.log('[QA Agent] PR_NUMBER not set — skipping QA run');
    return;
  }

  const prNum = parseInt(prNumber, 10);
  const [owner, repoName] = repo.includes('/') ? repo.split('/') : ['', ''];
  if (!owner || !repoName) {
    console.log(`[QA Agent] REPO "${repo}" is not in owner/repo format — skipping`);
    return;
  }

  console.log(`[QA Agent] Starting QA for PR #${prNum} at ${previewUrl}`);

  // Initialize clients
  const octokit = new Octokit({ auth: githubToken });

  // 3. Fetch PR body
  const { data: pr } = await octokit.pulls.get({
    owner,
    repo: repoName,
    pull_number: prNum,
  });
  const prBody = pr.body || '';
  console.log(`[QA Agent] PR title: ${pr.title}`);

  // 4. Parse acceptance criteria
  const criteria = parseAcceptanceCriteria(prBody);
  console.log(`[QA Agent] Found ${criteria.length} acceptance criteria`);

  // 5. Extract touched file paths and derive routes
  const filePaths = extractFilePaths(prBody);
  const touchedRoutes = deriveRoutesFromPaths(filePaths);
  console.log(`[QA Agent] Derived ${touchedRoutes.length} routes from ${filePaths.length} file paths`);

  // 6. Run smoke test
  const smokeStart = Date.now();
  const rawSmoke = await runSmokeTest(previewUrl, touchedRoutes, qaBypassSecret);
  const smokeDuration = Date.now() - smokeStart;
  const smokeResult = toReportSmokeTest(rawSmoke, smokeDuration);
  console.log(`[QA Agent] Smoke test: ${rawSmoke.overallPassed ? 'PASSED' : 'FAILED'} (${smokeDuration}ms)`);

  // 7/8. Criteria verification
  const criteriaResults: CriterionResult[] = [];

  if (!rawSmoke.overallPassed) {
    // Smoke failed: skip Pass 2, mark all criteria as fail/skip
    console.log('[QA Agent] Smoke test failed — skipping acceptance criteria verification');
    for (const c of criteria) {
      criteriaResults.push({
        criterion: c.criterion,
        status: 'skip',
        evidence: 'Skipped — smoke test failed (deployment may be unreachable)',
      });
    }
  } else if (criteria.length === 0) {
    console.log('[QA Agent] No acceptance criteria found in PR body');
  } else {
    // Call Claude for verification plan
    let verificationPlan: ClaudeVerificationItem[] = criteria.map((c) => ({
      criterion: c.criterion,
      category: c.category,
      skipReason: c.category === 'not-verifiable' ? 'Not verifiable via browser automation' : undefined,
    }));

    if (anthropicApiKey) {
      try {
        const anthropic = new Anthropic({ apiKey: anthropicApiKey });
        const systemPrompt = fs.readFileSync(
          path.join(__dirname, 'system-prompt.md'),
          'utf-8'
        );

        // Fetch PR diff
        let prDiff = '';
        try {
          const { data: diffData } = await octokit.pulls.get({
            owner,
            repo: repoName,
            pull_number: prNum,
            mediaType: { format: 'diff' },
          });
          prDiff = String(diffData);
        } catch {
          console.log('[QA Agent] Could not fetch PR diff — proceeding without it');
        }

        verificationPlan = await getClaudeVerificationPlan(
          anthropic,
          systemPrompt,
          prDiff,
          criteria,
          previewUrl
        );
        console.log('[QA Agent] Claude verification plan received');
      } catch (err: unknown) {
        console.log(
          `[QA Agent] Claude API error: ${err instanceof Error ? err.message : 'unknown'} — using pre-classifications`
        );
      }
    } else {
      console.log('[QA Agent] ANTHROPIC_API_KEY not set — using pre-classifications only');
    }

    // 9/10/11. Execute verification for each criterion
    for (const item of verificationPlan) {
      if (item.category === 'http' && item.httpEndpoint) {
        // HTTP verification
        const result = await httpCheck(item.httpEndpoint, qaBypassSecret);
        if (result.error) {
          criteriaResults.push({
            criterion: item.criterion,
            status: 'fail',
            evidence: `HTTP request failed: ${result.error}`,
          });
        } else {
          const statusOk = item.expectedStatus
            ? result.status === item.expectedStatus
            : result.status >= 200 && result.status < 500;
          const bodyOk = item.expectedBodyContains
            ? result.body.includes(item.expectedBodyContains)
            : true;

          criteriaResults.push({
            criterion: item.criterion,
            status: statusOk && bodyOk ? 'pass' : 'fail',
            evidence: statusOk && bodyOk
              ? `HTTP ${result.status} — verification passed`
              : `HTTP ${result.status}${!bodyOk ? ' — expected content not found' : ' — unexpected status'}`,
          });
        }
      } else if (item.category === 'playwright') {
        // Playwright: skip in v1
        criteriaResults.push({
          criterion: item.criterion,
          status: 'skip',
          evidence: 'Playwright dynamic test generation pending',
        });
      } else {
        // not-verifiable
        criteriaResults.push({
          criterion: item.criterion,
          status: 'skip',
          evidence: item.skipReason || 'Not verifiable via browser automation',
        });
      }
    }
  }

  // 12. Compute verdict
  const { verdict, summary: verdictSummary } = computeVerdict(criteriaResults);

  // 13. Format PR comment
  const report: QAReport = {
    previewUrl,
    smokeTest: smokeResult,
    criteriaResults,
    verdict,
    verdictSummary,
  };
  const commentBody = `${QA_MARKER}\n${formatPRComment(report)}`;

  // 14. Post/update comment
  if (githubToken) {
    try {
      // Check for existing QA Agent comment
      const { data: comments } = await octokit.issues.listComments({
        owner,
        repo: repoName,
        issue_number: prNum,
        per_page: 100,
      });

      const existingComment = comments.find(
        (c) => c.body?.includes(QA_MARKER)
      );

      if (existingComment) {
        await octokit.issues.updateComment({
          owner,
          repo: repoName,
          comment_id: existingComment.id,
          body: commentBody,
        });
        console.log(`[QA Agent] Updated existing comment #${existingComment.id}`);
      } else {
        await octokit.issues.createComment({
          owner,
          repo: repoName,
          issue_number: prNum,
          body: commentBody,
        });
        console.log('[QA Agent] Posted new QA report comment');
      }
    } catch (err: unknown) {
      console.log(
        `[QA Agent] Failed to post comment: ${err instanceof Error ? err.message : 'unknown'}`
      );
    }
  } else {
    console.log('[QA Agent] GITHUB_TOKEN not set — skipping comment posting');
    console.log(commentBody);
  }

  // 15. Log final verdict
  console.log(`[QA Agent] Verdict: ${verdict} — ${verdictSummary}`);
}

// Wrap in try/catch — advisory mode, always exit 0
main()
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error(
      `[QA Agent] Unhandled error: ${err instanceof Error ? err.message : 'unknown'}`
    );
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(0);
  });
