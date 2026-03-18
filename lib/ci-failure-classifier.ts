import { getWorkflowRunDetail } from "./github";

export type CIFailureCategory = 'infra' | 'test' | 'lint' | 'build' | 'unknown';

/**
 * Infra failure patterns — transient CI infrastructure issues that are safe to auto-retry.
 * Matches against failed job/step names and conclusions.
 */
const INFRA_STEP_PATTERNS: RegExp[] = [
  /checkout/i,
  /setup.*node/i,
  /setup.*python/i,
  /setup.*java/i,
  /install.*dependencies/i,
  /npm ci/i,
  /cache/i,
  /artifact/i,
  /download/i,
  /upload/i,
  /actions\/checkout/i,
  /actions\/setup/i,
  /actions\/cache/i,
];

/**
 * Classify a CI workflow run failure by inspecting its jobs and failed steps.
 *
 * Returns 'infra' for transient infrastructure failures (checkout, runner, artifact issues),
 * 'test' for test failures, 'lint' for linting failures, 'build' for build failures,
 * or 'unknown' if the failure cannot be classified.
 */
export async function classifyCIFailure(
  repo: string,
  runId: number
): Promise<CIFailureCategory> {
  try {
    const detail = await getWorkflowRunDetail(repo, runId);

    const failedJobs = detail.jobs.filter(
      (j) => j.conclusion === "failure" || j.conclusion === "cancelled"
    );

    if (failedJobs.length === 0) {
      return 'unknown';
    }

    // Collect all failed steps across all failed jobs
    const failedSteps: string[] = [];
    for (const job of failedJobs) {
      if (job.steps) {
        for (const step of job.steps) {
          if (step.conclusion === "failure" || step.conclusion === "cancelled") {
            failedSteps.push(step.name);
          }
        }
      }
    }

    // If no individual step failures found, check job names
    if (failedSteps.length === 0) {
      // Job failed but no step-level detail — could be runner-level infra issue
      const jobNames = failedJobs.map((j) => j.name.toLowerCase());
      if (jobNames.some((n) => n.includes('setup') || n.includes('checkout'))) {
        return 'infra';
      }
      return 'unknown';
    }

    // Check if ALL failed steps match infra patterns
    const allInfra = failedSteps.every((stepName) =>
      INFRA_STEP_PATTERNS.some((pattern) => pattern.test(stepName))
    );
    if (allInfra) {
      return 'infra';
    }

    // Classify by step names
    const stepNamesLower = failedSteps.map((s) => s.toLowerCase());

    if (stepNamesLower.some((s) => s.includes('test') || s.includes('jest') || s.includes('vitest'))) {
      return 'test';
    }
    if (stepNamesLower.some((s) => s.includes('lint') || s.includes('eslint'))) {
      return 'lint';
    }
    if (stepNamesLower.some((s) => s.includes('build') || s.includes('compile') || s.includes('tsc'))) {
      return 'build';
    }

    return 'unknown';
  } catch {
    // If we can't fetch run details, we can't classify — return unknown
    return 'unknown';
  }
}
