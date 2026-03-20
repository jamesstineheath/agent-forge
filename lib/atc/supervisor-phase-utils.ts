/**
 * Shared utilities for supervisor phase route handlers.
 */

import { NextRequest, NextResponse } from "next/server";
import type { PhaseResult } from "./supervisor-manifest";

export interface PhaseRequestBody {
  cycleId: string;
  timestamp: string;
}

/**
 * Authenticate a phase request using CRON_SECRET bearer token.
 * Returns null if auth passes, or a 401 NextResponse if it fails.
 */
export function authenticatePhaseRequest(req: NextRequest): NextResponse | null {
  const authHeader = req.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

/**
 * Parse the phase request body.
 */
export async function parsePhaseBody(req: NextRequest): Promise<PhaseRequestBody> {
  const body = await req.json() as PhaseRequestBody;
  return body;
}

/**
 * Build a successful phase response.
 */
export function phaseSuccess(
  durationMs: number,
  opts?: { decisions?: string[]; outputs?: Record<string, unknown> }
): NextResponse<PhaseResult> {
  return NextResponse.json({
    name: '', // filled by coordinator from manifest
    tier: '',
    status: 'success' as const,
    durationMs,
    decisions: opts?.decisions,
    outputs: opts?.outputs,
  });
}

/**
 * Build a failure phase response.
 */
export function phaseFailure(
  durationMs: number,
  errors: string[]
): NextResponse<PhaseResult> {
  return NextResponse.json({
    name: '',
    tier: '',
    status: 'failure' as const,
    durationMs,
    errors,
  });
}

/**
 * Wrap a phase handler function, catching all errors.
 */
export async function runPhaseHandler(
  req: NextRequest,
  handler: (body: PhaseRequestBody) => Promise<{ durationMs: number; decisions?: string[]; errors?: string[]; outputs?: Record<string, unknown> }>
): Promise<NextResponse> {
  const authError = authenticatePhaseRequest(req);
  if (authError) return authError;

  const body = await parsePhaseBody(req);
  const start = Date.now();

  try {
    const result = await handler(body);
    if (result.errors && result.errors.length > 0) {
      return phaseFailure(result.durationMs, result.errors);
    }
    return phaseSuccess(result.durationMs, { decisions: result.decisions, outputs: result.outputs });
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[supervisor-phase] Handler error:`, message);
    return phaseFailure(durationMs, [message]);
  }
}
