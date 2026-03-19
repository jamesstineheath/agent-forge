/**
 * Intent Validator — verifies acceptance criteria against live deployments.
 *
 * Runs as a Supervisor phase after project completion. For each criterion,
 * uses Claude (Sonnet) to interpret the PM-language description into an
 * HTTP probe, executes it against the production URL, then evaluates
 * whether the criterion is met.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Anthropic = require("@anthropic-ai/sdk");
import { updateCriterionStatus, findUnverifiedCriteria } from "./intent-criteria";
import { listWorkItems } from "./work-items";
import { createWorkItem } from "./work-items";
import type {
  IntentCriteria,
  Criterion,
  ValidationResult,
  ValidationProbe,
  CriterionStatus,
} from "./types";

// ── Constants ────────────────────────────────────────────────────────────────

const CLAUDE_MODEL = "claude-sonnet-4-5-20241022";
const PROBE_TIMEOUT_MS = 10000;
const MAX_CRITERIA_PER_CYCLE = 20; // avoid Supervisor timeout

// Production URL mapping
const REPO_URLS: Record<string, string> = {
  "agent-forge": "https://agent-forge-phi.vercel.app",
  "jamesstineheath/agent-forge": "https://agent-forge-phi.vercel.app",
  "personal-assistant": "https://personal-assistant-phi.vercel.app",
  "jamesstineheath/personal-assistant": "https://personal-assistant-phi.vercel.app",
};

// ── Probe Generation (Claude) ────────────────────────────────────────────────

async function generateProbe(
  criterion: Criterion,
  productionUrl: string,
  targetRepo: string,
): Promise<ValidationProbe> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { path: "/", method: "GET", lookFor: "", confidence: "low", skipReason: "No ANTHROPIC_API_KEY" };
  }

  const anthropic = new Anthropic({ apiKey });

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 300,
    system: `You determine how to verify an acceptance criterion against a live web application.
Given a criterion description, production URL, and target repo, determine:
1. What URL path to check (e.g., /realestate, /api/travel/profile, /agents)
2. HTTP method (GET or POST)
3. What to look for in the response HTML or JSON to confirm the criterion is met
4. Your confidence that this can be verified via HTTP (high/medium/low)

If the criterion describes something that can't be verified via HTTP (e.g., "system learns over time", "cron runs daily"), set confidence to "low" and provide a skipReason.

Return ONLY valid JSON: { "path": string, "method": "GET"|"POST", "lookFor": string, "confidence": "high"|"medium"|"low", "skipReason"?: string }`,
    messages: [{
      role: "user",
      content: `Criterion: "${criterion.description}"
Production URL: ${productionUrl}
Target repo: ${targetRepo}
Criterion type: ${criterion.type}`,
    }],
  });

  const text = response.content
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("")
    .trim();

  try {
    const parsed = JSON.parse(text);
    return {
      path: parsed.path || "/",
      method: parsed.method === "POST" ? "POST" : "GET",
      lookFor: parsed.lookFor || "",
      confidence: parsed.confidence || "low",
      skipReason: parsed.skipReason,
    };
  } catch {
    // If Claude returns non-JSON, skip
    return { path: "/", method: "GET", lookFor: "", confidence: "low", skipReason: `Parse error: ${text.slice(0, 100)}` };
  }
}

// ── HTTP Probe Execution ─────────────────────────────────────────────────────

async function executeProbe(
  productionUrl: string,
  probe: ValidationProbe,
): Promise<{ status: number; body: string; durationMs: number }> {
  const url = `${productionUrl}${probe.path}`;
  const start = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: probe.method,
      signal: controller.signal,
      headers: {
        "User-Agent": "AgentForge-IntentValidator/1.0",
        Accept: "text/html,application/json",
      },
    });

    const body = await response.text();
    return {
      status: response.status,
      body: body.slice(0, 5000), // cap body size
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      status: 0,
      body: `Fetch error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Result Evaluation (Claude) ───────────────────────────────────────────────

async function evaluateResult(
  criterion: Criterion,
  probe: ValidationProbe,
  probeResult: { status: number; body: string },
): Promise<{ passed: boolean; evidence: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { passed: false, evidence: "No ANTHROPIC_API_KEY for evaluation" };
  }

  // Quick checks before using Claude
  if (probeResult.status === 0) {
    return { passed: false, evidence: `Request failed: ${probeResult.body}` };
  }
  if (probeResult.status >= 500) {
    return { passed: false, evidence: `Server error: HTTP ${probeResult.status}` };
  }

  const anthropic = new Anthropic({ apiKey });

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 200,
    system: `You evaluate whether an acceptance criterion is met based on an HTTP response.
Return ONLY valid JSON: { "passed": boolean, "evidence": string }
The evidence should be a brief (1 sentence) explanation of why it passed or failed.
Be strict: if the response doesn't clearly demonstrate the criterion, mark as failed.`,
    messages: [{
      role: "user",
      content: `Criterion: "${criterion.description}"
Expected to find: "${probe.lookFor}"
HTTP status: ${probeResult.status}
Response body (first 2000 chars):
${probeResult.body.slice(0, 2000)}`,
    }],
  });

  const text = response.content
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("")
    .trim();

  try {
    const parsed = JSON.parse(text);
    return {
      passed: !!parsed.passed,
      evidence: parsed.evidence || (parsed.passed ? "Criterion verified" : "Criterion not met"),
    };
  } catch {
    return { passed: false, evidence: `Evaluation parse error: ${text.slice(0, 100)}` };
  }
}

// ── Main Validation Function ─────────────────────────────────────────────────

/**
 * Validate a single criterion against the live deployment.
 */
async function validateCriterion(
  criterion: Criterion,
  productionUrl: string,
  targetRepo: string,
): Promise<ValidationResult> {
  const start = Date.now();

  // Skip already verified criteria
  if (criterion.status === "passed" || criterion.status === "failed") {
    return {
      criterionId: criterion.id,
      criterionDescription: criterion.description,
      status: criterion.status,
      evidence: criterion.evidence || "Previously verified",
      durationMs: 0,
    };
  }

  // Generate probe
  const probe = await generateProbe(criterion, productionUrl, targetRepo);

  // Skip low-confidence probes
  if (probe.confidence === "low" || probe.skipReason) {
    return {
      criterionId: criterion.id,
      criterionDescription: criterion.description,
      status: "skipped",
      evidence: probe.skipReason || "Low confidence — cannot verify via HTTP",
      probe,
      durationMs: Date.now() - start,
    };
  }

  // Execute probe
  const probeResult = await executeProbe(productionUrl, probe);

  // Evaluate result
  const evaluation = await evaluateResult(criterion, probe, probeResult);

  return {
    criterionId: criterion.id,
    criterionDescription: criterion.description,
    status: evaluation.passed ? "passed" : "failed",
    evidence: evaluation.evidence,
    probe,
    responseStatus: probeResult.status,
    durationMs: Date.now() - start,
  };
}

/**
 * Validate all criteria for a single PRD against its production deployment.
 */
export async function validateIntentCriteria(
  criteria: IntentCriteria,
): Promise<ValidationResult[]> {
  const productionUrl = REPO_URLS[criteria.targetRepo || ""] || REPO_URLS["agent-forge"];

  if (!productionUrl) {
    console.warn(`[intent-validator] No production URL for repo "${criteria.targetRepo}"`);
    return [];
  }

  console.log(
    `[intent-validator] Validating "${criteria.prdTitle}" (${criteria.criteria.length} criteria) against ${productionUrl}`
  );

  const results: ValidationResult[] = [];
  const pendingCriteria = criteria.criteria.filter((c) => c.status === "pending");

  for (const criterion of pendingCriteria.slice(0, MAX_CRITERIA_PER_CYCLE)) {
    try {
      const result = await validateCriterion(criterion, productionUrl, criteria.targetRepo || "");
      results.push(result);

      // Update status in blob store
      await updateCriterionStatus(criteria.prdId, criterion.id, result.status, result.evidence);

      console.log(
        `[intent-validator]   ${criterion.id}: ${result.status} — ${result.evidence?.slice(0, 80)}`
      );
    } catch (err) {
      console.error(`[intent-validator]   ${criterion.id}: error — ${err}`);
      results.push({
        criterionId: criterion.id,
        criterionDescription: criterion.description,
        status: "skipped",
        evidence: `Validation error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return results;
}

// ── Gap Analysis: File Follow-Up Work Items ──────────────────────────────────

/**
 * For failed criteria, file follow-up work items so the pipeline can fix them.
 */
export async function fileFollowUpWorkItems(
  criteria: IntentCriteria,
  results: ValidationResult[],
): Promise<number> {
  const failedResults = results.filter((r) => r.status === "failed");
  if (failedResults.length === 0) return 0;

  let filed = 0;

  for (const result of failedResults) {
    try {
      await createWorkItem({
        title: `Fix: ${result.criterionDescription.slice(0, 80)}`,
        description: [
          `## Acceptance Criterion Failed`,
          ``,
          `**PRD:** ${criteria.prdTitle}`,
          `**Criterion:** ${result.criterionDescription}`,
          `**Type:** ${criteria.criteria.find((c) => c.id === result.criterionId)?.type || "unknown"}`,
          `**Evidence:** ${result.evidence}`,
          result.probe ? `**Probe:** ${result.probe.method} ${result.probe.path}` : "",
          result.responseStatus ? `**HTTP Status:** ${result.responseStatus}` : "",
          ``,
          `Fix the issue so this criterion passes on the next validation cycle.`,
        ].filter(Boolean).join("\n"),
        targetRepo: criteria.targetRepo || "jamesstineheath/agent-forge",
        source: {
          type: "project" as const,
          sourceId: criteria.projectId || undefined,
        },
        priority: "high" as const,
        complexity: "simple" as const,
        riskLevel: "low" as const,
        dependencies: [],
      });
      filed++;
    } catch (err) {
      console.error(`[intent-validator] Failed to file work item for ${result.criterionId}:`, err);
    }
  }

  console.log(`[intent-validator] Filed ${filed} follow-up work item(s) for "${criteria.prdTitle}"`);
  return filed;
}

// ── Supervisor Entry Point ───────────────────────────────────────────────────

/**
 * Run intent validation for all criteria sets that have unverified criteria.
 * Called by the Supervisor's §20 phase.
 * Throttled to 1 criteria set per cycle to avoid timeout.
 */
export async function runIntentValidation(): Promise<{
  validated: number;
  passed: number;
  failed: number;
  skipped: number;
  followUps: number;
}> {
  const unverified = await findUnverifiedCriteria();

  if (unverified.length === 0) {
    return { validated: 0, passed: 0, failed: 0, skipped: 0, followUps: 0 };
  }

  // Throttle: validate at most 1 criteria set per cycle
  const toValidate = unverified[0];

  // Check if the associated project has all items in terminal state
  if (toValidate.projectId) {
    const allItems = await listWorkItems({});
    const projectItems = allItems.filter(
      (item) => {
        const wi = item as { sourceId?: string; source?: { sourceId?: string } };
        const sourceId = wi.source?.sourceId || wi.sourceId;
        return sourceId === toValidate.projectId;
      }
    );

    const terminalStatuses = new Set(["merged", "parked", "cancelled", "failed", "superseded"]);
    const nonTerminal = projectItems.filter((item) => !terminalStatuses.has(item.status));

    if (nonTerminal.length > 0) {
      console.log(
        `[intent-validator] Skipping "${toValidate.prdTitle}" — ${nonTerminal.length} work items still in progress`
      );
      return { validated: 0, passed: 0, failed: 0, skipped: 0, followUps: 0 };
    }
  }

  const results = await validateIntentCriteria(toValidate);
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  // File follow-up work items for failures
  let followUps = 0;
  if (failed > 0) {
    followUps = await fileFollowUpWorkItems(toValidate, results);
  }

  console.log(
    `[intent-validator] "${toValidate.prdTitle}": ${passed} passed, ${failed} failed, ${skipped} skipped, ${followUps} follow-ups filed`
  );

  return { validated: results.length, passed, failed, skipped, followUps };
}
