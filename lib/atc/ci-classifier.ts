import { getWorkflowRunDetail } from "../github";
import type { AgentTrace } from "./tracing";
import { addDecision } from "./tracing";

// Classification constants — easy to extend later
const INFRA_STEP_NAMES = new Set([
  'Set up job',
  'checkout',
  'actions/checkout',
  'setup-node',
  'actions/setup-node',
  'Set up runner',
]);

const CODE_STEP_NAMES = new Set([
  'npm run build',
  'Run npm run build',
  'npm test',
  'Run npm test',
  'npm run test',
  'Run npm run test',
  'npx tsc',
  'Run npx tsc',
]);

const INFRA_CONCLUSIONS = new Set(['cancelled', 'timed_out']);

export interface CIFailureClassification {
  classification: 'infra' | 'code' | 'unknown';
  failedStep: string;
  reason: string;
}

function emitClassified(
  trace: AgentTrace | undefined,
  result: CIFailureClassification,
  runId: number,
  repoFullName: string,
): void {
  if (trace) {
    addDecision(trace, {
      action: 'ci.failure_classified',
      reason: result.reason,
      classification: result.classification,
      failedStep: result.failedStep,
      runId,
      repoFullName,
    });
  }
}

/**
 * Classifies a GitHub Actions workflow run failure without LLM calls.
 * Returns classification, the name of the first failed step, and a human-readable reason.
 *
 * Optionally accepts an AgentTrace to record decisions via the existing tracing infrastructure.
 */
export async function classifyCIFailure(
  runId: number,
  repoFullName: string,
  trace?: AgentTrace
): Promise<CIFailureClassification> {
  // Emit detection trace event BEFORE fetching (captures intent)
  if (trace) {
    addDecision(trace, {
      action: 'ci.failure_detected',
      reason: `Investigating workflow run ${runId} on ${repoFullName}`,
      runId,
      repoFullName,
    });
  }

  let detail;
  try {
    detail = await getWorkflowRunDetail(repoFullName, runId);
  } catch (err) {
    const result: CIFailureClassification = {
      classification: 'unknown',
      failedStep: 'unknown',
      reason: `Failed to fetch workflow run jobs: ${String(err)}`,
    };
    emitClassified(trace, result, runId, repoFullName);
    return result;
  }

  // Check for infra-level conclusion on jobs (cancelled/timed_out)
  for (const job of detail.jobs) {
    if (job.conclusion && INFRA_CONCLUSIONS.has(job.conclusion)) {
      const result: CIFailureClassification = {
        classification: 'infra',
        failedStep: job.name,
        reason: `Job "${job.name}" concluded with "${job.conclusion}"`,
      };
      emitClassified(trace, result, runId, repoFullName);
      return result;
    }
  }

  // Find first failed step across all jobs
  let firstFailedStep: { jobName: string; stepName: string } | null = null;

  outer: for (const job of detail.jobs) {
    const steps = job.steps ?? [];
    const sorted = [...steps].sort((a, b) => a.number - b.number);
    for (const step of sorted) {
      if (step.conclusion === 'failure') {
        firstFailedStep = { jobName: job.name, stepName: step.name };
        break outer;
      }
    }
  }

  if (!firstFailedStep) {
    const result: CIFailureClassification = {
      classification: 'unknown',
      failedStep: 'none',
      reason: 'No failed step found in workflow run jobs',
    };
    emitClassified(trace, result, runId, repoFullName);
    return result;
  }

  const stepName = firstFailedStep.stepName;

  let result: CIFailureClassification;

  if (INFRA_STEP_NAMES.has(stepName)) {
    result = {
      classification: 'infra',
      failedStep: stepName,
      reason: `Step "${stepName}" is a known infra/setup step`,
    };
  } else if (CODE_STEP_NAMES.has(stepName)) {
    result = {
      classification: 'code',
      failedStep: stepName,
      reason: `Step "${stepName}" is a known build/test step`,
    };
  } else {
    result = {
      classification: 'unknown',
      failedStep: stepName,
      reason: `Step "${stepName}" is not in the known infra or code step lists`,
    };
  }

  emitClassified(trace, result, runId, repoFullName);
  return result;
}
