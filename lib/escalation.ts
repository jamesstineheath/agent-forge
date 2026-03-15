import { loadJson, saveJson, deleteJson } from "./storage";
import { getWorkItem, updateWorkItem } from "./work-items";

export interface Escalation {
  id: string;
  workItemId: string;
  projectId?: string;
  reason: string;
  confidenceScore: number; // 0-1, how confident the system is that escalation is needed
  contextSnapshot: Record<string, unknown>; // Full state snapshot at time of escalation
  status: "pending" | "resolved" | "expired";
  createdAt: string;
  resolvedAt?: string;
  resolution?: string; // Human-provided resolution or outcome
  threadId?: string; // For Gmail integration (Handoff 12)
  reminderSentAt?: string; // When reminder email was sent
}

const ESCALATIONS_INDEX_KEY = "escalations/index";

function getEscalationKey(id: string): string {
  return `escalations/${id}`;
}

/**
 * Create a new escalation and transition the work item to "blocked"
 */
export async function escalate(
  workItemId: string,
  reason: string,
  confidenceScore: number,
  contextSnapshot: Record<string, unknown>,
  projectId?: string
): Promise<Escalation> {
  const id = `esc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date().toISOString();

  const escalation: Escalation = {
    id,
    workItemId,
    ...(projectId && { projectId }),
    reason,
    confidenceScore: Math.max(0, Math.min(1, confidenceScore)),
    contextSnapshot,
    status: "pending",
    createdAt: now,
  };

  // Save the escalation record
  await saveJson(getEscalationKey(id), escalation);

  // Update the index
  const index = (await loadJson<string[]>(ESCALATIONS_INDEX_KEY)) ?? [];
  if (!index.includes(id)) {
    index.push(id);
    await saveJson(ESCALATIONS_INDEX_KEY, index);
  }

  // Update work item status to "blocked"
  const workItem = await getWorkItem(workItemId);
  if (workItem) {
    await updateWorkItem(workItemId, {
      status: "blocked",
      escalation: {
        id,
        reason,
        blockedAt: now,
      },
    });

    // Attempt to send escalation email via Gmail
    const { sendEscalationEmail } = await import("./gmail");
    const threadId = await sendEscalationEmail(escalation, workItem);
    if (threadId) {
      await updateEscalation(id, { threadId });
    }
  } else if (projectId) {
    console.log(`[escalation] Project-level escalation for project ${projectId} (no work item to block)`);
  }

  console.log(`[escalation] Created escalation ${id} for work item ${workItemId}: ${reason}`);

  return escalation;
}

/**
 * Update an escalation record with partial data
 */
export async function updateEscalation(
  id: string,
  patch: Partial<Escalation>
): Promise<Escalation | null> {
  try {
    const escalation = await getEscalation(id);
    if (!escalation) return null;

    const updated = { ...escalation, ...patch };
    await saveJson(getEscalationKey(id), updated);
    return updated;
  } catch (error) {
    console.error(`[escalation] Failed to update escalation ${id}:`, error);
    return null;
  }
}

/**
 * Resolve an escalation and transition the work item back to "queued"
 */
export async function resolveEscalation(
  id: string,
  resolution: string
): Promise<Escalation | null> {
  const escalation = await getEscalation(id);
  if (!escalation) return null;

  const now = new Date().toISOString();
  const updated: Escalation = {
    ...escalation,
    status: "resolved",
    resolvedAt: now,
    resolution,
  };

  await saveJson(getEscalationKey(id), updated);
  console.log(`[escalation] Resolved escalation ${id}: ${resolution}`);

  return updated;
}

/**
 * Mark an escalation as expired (timeout after 24h without resolution)
 */
export async function expireEscalation(id: string): Promise<Escalation | null> {
  const escalation = await getEscalation(id);
  if (!escalation) return null;

  const updated: Escalation = {
    ...escalation,
    status: "expired",
  };

  await saveJson(getEscalationKey(id), updated);
  console.log(`[escalation] Marked escalation ${id} as expired (timeout)`);

  return updated;
}

/**
 * Get a single escalation by ID
 */
export async function getEscalation(id: string): Promise<Escalation | null> {
  return loadJson<Escalation>(getEscalationKey(id));
}

/**
 * List all escalations with optional status filter
 */
export async function listEscalations(
  statusFilter?: "pending" | "resolved" | "expired" | "all"
): Promise<Escalation[]> {
  const index = (await loadJson<string[]>(ESCALATIONS_INDEX_KEY)) ?? [];

  const escalations: Escalation[] = [];
  for (const id of index) {
    const esc = await getEscalation(id);
    if (esc) {
      if (!statusFilter || statusFilter === "all" || esc.status === statusFilter) {
        escalations.push(esc);
      }
    }
  }

  // Sort by created time, newest first
  escalations.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return escalations;
}

/**
 * Get all pending escalations
 */
export async function getPendingEscalations(): Promise<Escalation[]> {
  return listEscalations("pending");
}

/**
 * Delete an escalation (cleanup only, typically after expiration or resolution)
 */
export async function deleteEscalation(id: string): Promise<boolean> {
  try {
    await deleteJson(getEscalationKey(id));
    const index = (await loadJson<string[]>(ESCALATIONS_INDEX_KEY)) ?? [];
    const updated = index.filter((i) => i !== id);
    await saveJson(ESCALATIONS_INDEX_KEY, updated);
    return true;
  } catch (err) {
    console.error(`[escalation] Failed to delete escalation ${id}:`, err);
    return false;
  }
}
