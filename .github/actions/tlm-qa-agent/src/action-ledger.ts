import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface SmokeTestLedgerResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

export interface AcceptanceCriteriaVerdict {
  criterion: string;
  verdict: 'pass' | 'fail' | 'skip';
  evidence?: string;
}

export interface QAActionLedgerEntry {
  timestamp: string;           // ISO 8601
  agentType: 'qa-agent';
  prNumber: number | null;
  repo: string;
  outcome: 'pass' | 'fail';
  smokeTestResults: SmokeTestLedgerResult[];
  acceptanceCriteriaVerdicts: AcceptanceCriteriaVerdict[];
  totalDurationMs: number;
  deployUrl: string | null;
  runId: string;
  assessedOutcome: string | null;  // Filled later by Outcome Tracker; null on creation
}

const LEDGER_PATH = path.resolve(process.cwd(), 'docs', 'tlm-action-ledger.json');

export async function logToActionLedger(entry: QAActionLedgerEntry): Promise<void> {
  console.log('[action-ledger] Writing entry to ledger...');

  // Ensure docs/ directory exists
  const docsDir = path.dirname(LEDGER_PATH);
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  // Read existing ledger or initialize empty array
  let ledger: QAActionLedgerEntry[] = [];
  if (fs.existsSync(LEDGER_PATH)) {
    try {
      const raw = fs.readFileSync(LEDGER_PATH, 'utf-8');
      ledger = JSON.parse(raw);
      if (!Array.isArray(ledger)) {
        console.warn('[action-ledger] Ledger file was not an array — reinitializing');
        ledger = [];
      }
    } catch (err) {
      console.warn('[action-ledger] Failed to parse existing ledger, reinitializing:', err);
      ledger = [];
    }
  } else {
    console.log('[action-ledger] Ledger file not found, creating new one');
  }

  // Append new entry
  ledger.push(entry);

  // Write back
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n', 'utf-8');
  console.log(`[action-ledger] Ledger updated. Total entries: ${ledger.length}`);

  // Commit and push
  try {
    execSync('git config user.email "tlm-qa-agent@agent-forge.bot"', { stdio: 'inherit' });
    execSync('git config user.name "TLM QA Agent"', { stdio: 'inherit' });
    execSync(`git add ${LEDGER_PATH}`, { stdio: 'inherit' });

    // Check if there are staged changes before committing
    const diff = execSync('git diff --cached --name-only').toString().trim();
    if (!diff) {
      console.log('[action-ledger] No changes to commit (ledger unchanged)');
      return;
    }

    const commitMsg = `chore: tlm-qa-agent ledger entry [run ${entry.runId}]`;
    execSync(`git commit -m "${commitMsg}"`, { stdio: 'inherit' });
    execSync('git push', { stdio: 'inherit' });
    console.log('[action-ledger] Ledger committed and pushed successfully');
  } catch (err) {
    // Non-fatal: log the error but don't fail the QA run
    console.error('[action-ledger] Failed to commit/push ledger update:', err);
  }
}
