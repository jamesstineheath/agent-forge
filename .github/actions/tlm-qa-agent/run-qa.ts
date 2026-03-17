#!/usr/bin/env node
/**
 * run-qa.ts — QA Agent orchestrator stub
 *
 * Full implementation pending (smoke test runner, PR comment formatter, etc.).
 * This stub exits cleanly so CI does not block PRs while the QA Agent is
 * being built out incrementally.
 */

const previewUrl = process.env.PREVIEW_URL || '(none)';
const prNumber   = process.env.PR_NUMBER   || '(none)';

console.log('[QA Agent] stub — no tests to run yet');
console.log('[QA Agent] preview-url: ' + previewUrl);
console.log('[QA Agent] pr-number:   ' + prNumber);
console.log('[QA Agent] exiting cleanly — full QA pending implementation');

process.exit(0);
