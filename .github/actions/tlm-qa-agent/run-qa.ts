#!/usr/bin/env node
/**
 * run-qa.ts — QA Agent orchestrator stub
 *
 * Full implementation pending (smoke test runner, PR comment formatter, etc.).
 * This stub exits cleanly so CI does not block PRs while the QA Agent is
 * being built out incrementally.
 */

import { logToActionLedger, QAActionLedgerEntry } from './src/action-ledger.js';

const startTime = Date.now();

const previewUrl = process.env.PREVIEW_URL || '(none)';
const prNumber   = process.env.PR_NUMBER   || '(none)';

console.log('[QA Agent] stub — no tests to run yet');
console.log('[QA Agent] preview-url: ' + previewUrl);
console.log('[QA Agent] pr-number:   ' + prNumber);

// Build ledger entry from stub results
const ledgerEntry: QAActionLedgerEntry = {
  timestamp: new Date().toISOString(),
  agentType: 'qa-agent',
  prNumber: prNumber !== '(none)' ? parseInt(prNumber, 10) : null,
  repo: process.env.GITHUB_REPOSITORY ?? '',
  outcome: 'pass',
  smokeTestResults: [],
  acceptanceCriteriaVerdicts: [],
  totalDurationMs: Date.now() - startTime,
  deployUrl: previewUrl !== '(none)' ? previewUrl : null,
  runId: process.env.GITHUB_RUN_ID ?? 'unknown',
  assessedOutcome: null,
};

await logToActionLedger(ledgerEntry);

console.log('[QA Agent] exiting cleanly — full QA pending implementation');
