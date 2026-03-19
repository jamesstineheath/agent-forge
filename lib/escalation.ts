import { loadJson, saveJson, deleteJson } from "./storage";
import { getWorkItem, updateWorkItem, createWorkItem } from "./work-items";

// --- Three-tier escalation routing types ---

type EscalationTier = 'auto_resolve' | 'engineer' | 'product_owner';

type AutoResolutionAction =
  | { type: 'park_and_refile'; errorContext: string }
  | { type: 'skip_and_defer'; deferTo: 'pm_sweep' }
  | { type: 'auto_fail_project' }
  | { type: 'proceed_anyway'; reason: string };

type EscalationClassification =
  | { tier: 'auto_resolve'; action: AutoResolutionAction }
  | { tier: 'engineer' }
  | { tier: 'product_owner' };

// --- Fast-lane escalation types ---

export type EscalationReason = 'spec_review_flag' | 'budget_exceeded' | 'complexity_flag' | 'spend-alert';

const ESCALATION_REASON_LABELS: Record<EscalationReason, string> = {
  spec_review_flag: 'Spec Review Flag — handoff was flagged during TLM spec review',
  budget_exceeded: 'Budget Exceeded — estimated cost exceeds fast-lane budget threshold',
  complexity_flag: 'Complexity Flag — item is too complex for fast-lane execution',
  'spend-alert': 'Spend Alert — Vercel spend threshold crossed',
};

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
 * Classify an escalation into a tier based on pattern-matching the reason string.
 */
function classifyEscalation(reason: string, _context?: Record<string, unknown>): EscalationClassification {
  const r = reason.toLowerCase();

  // CI failure after retry → park and refile
  if (r.includes('ci failed') || r.includes('ci failure') || r.includes('failed with code error')) {
    return {
      tier: 'auto_resolve',
      action: { type: 'park_and_refile', errorContext: reason }
    };
  }

  // Decomposition oversized / sub-phase → proceed anyway
  if (r.includes('decomposition produced') && r.includes('items') && r.includes('max')) {
    return {
      tier: 'auto_resolve',
      action: { type: 'proceed_anyway', reason: 'Oversized decomposition — proceeding with all items' }
    };
  }
  if (r.includes('sub-phase') && (r.includes('oversized') || r.includes('too large') || r.includes('exceed'))) {
    return {
      tier: 'auto_resolve',
      action: { type: 'proceed_anyway', reason: 'Oversized sub-phase — proceeding anyway' }
    };
  }

  // Empty plan → auto-fail project
  if (r.includes('plan page is empty') || r.includes('empty plan') || r.includes('no target repo')) {
    return {
      tier: 'auto_resolve',
      action: { type: 'auto_fail_project' }
    };
  }

  // Plan validation errors → auto-fail; warnings → defer to PM sweep
  if (r.includes('plan validation found') || r.includes('plan validation')) {
    const hasErrors = r.includes('error') || r.includes('invalid') || r.includes('failed');
    const onlyWarnings = r.includes('warning') && !hasErrors;
    if (onlyWarnings) {
      return {
        tier: 'auto_resolve',
        action: { type: 'skip_and_defer', deferTo: 'pm_sweep' }
      };
    }
    return {
      tier: 'auto_resolve',
      action: { type: 'auto_fail_project' }
    };
  }

  // Circular dependency → engineer tier
  if (r.includes('circular dependency') || r.includes('circular dep')) {
    return { tier: 'engineer' };
  }

  // Default: product owner
  return { tier: 'product_owner' };
}

/**
 * Transition a work item from "blocked" back to "ready".
 * No-op if the item doesn't exist or isn't in "blocked" status.
 */
async function unblockWorkItem(workItemId: string): Promise<void> {
  try {
    const workItem = await getWorkItem(workItemId);
    if (workItem && workItem.status === 'blocked') {
      await updateWorkItem(workItemId, { status: 'ready' });
    }
  } catch (err) {
    console.error(`[escalation] Failed to unblock work item ${workItemId}:`, err);
    // Non-fatal: escalation record is already updated
  }
}

// --- Tier handler functions ---

async function handleAutoResolve(
  escalation: Escalation,
  action: AutoResolutionAction
): Promise<void> {
  console.log(`[escalation] Auto-resolving ${escalation.id} via action: ${action.type}`);

  switch (action.type) {
    case 'park_and_refile': {
      if (escalation.workItemId) {
        await updateWorkItem(escalation.workItemId, { status: 'parked' });
        const original = await getWorkItem(escalation.workItemId);
        if (original) {
          const newItem = await createWorkItem({
            title: `Retry (different approach): ${original.title}`,
            description: `Original work item ${escalation.workItemId} was parked due to CI failure.\n\nError context:\n${action.errorContext}\n\nPlease attempt a different implementation approach to resolve this.`,
            targetRepo: original.targetRepo,
            source: original.source,
            priority: original.priority ?? 'medium',
            riskLevel: original.riskLevel,
            complexity: original.complexity,
            dependencies: [],
          });
          // Transition from 'filed' to 'ready' so it enters the dispatch queue
          await updateWorkItem(newItem.id, { status: 'ready' });
        }
      }
      break;
    }
    case 'proceed_anyway': {
      if (escalation.workItemId) {
        await unblockWorkItem(escalation.workItemId);
      }
      break;
    }
    case 'auto_fail_project': {
      // Work item remains blocked — it can't proceed with no valid plan
      break;
    }
    case 'skip_and_defer': {
      if (escalation.workItemId) {
        await unblockWorkItem(escalation.workItemId);
      }
      break;
    }
  }
}

async function handleEngineerEscalation(escalation: Escalation): Promise<void> {
  console.log(`[escalation] Filing engineer bugfix work item for escalation ${escalation.id}`);

  // Need the original work item to get targetRepo and source
  const original = escalation.workItemId ? await getWorkItem(escalation.workItemId) : null;
  const targetRepo = original?.targetRepo ?? 'jamesstineheath/agent-forge';

  await createWorkItem({
    title: `Bug: ${escalation.reason.slice(0, 100)}`,
    description: `Auto-filed by escalation system (Tier 2 — Engineer).\n\nEscalation ID: ${escalation.id}\nOriginal work item: ${escalation.workItemId ?? 'N/A'}\n\nReason:\n${escalation.reason}\n\nContext:\n${JSON.stringify(escalation.contextSnapshot ?? {}, null, 2)}`,
    targetRepo,
    source: { type: 'direct' },
    priority: 'high',
    riskLevel: 'medium',
    complexity: 'moderate',
    dependencies: [],
  });

  if (escalation.workItemId) {
    await unblockWorkItem(escalation.workItemId);
  }
}

async function handleProductOwnerEscalation(escalation: Escalation): Promise<void> {
  console.log(`[escalation] Sending product owner email for escalation ${escalation.id}`);
  const workItem = escalation.workItemId ? await getWorkItem(escalation.workItemId) : null;
  if (workItem) {
    const { sendEscalationEmail } = await import("./gmail");
    const threadId = await sendEscalationEmail(escalation, workItem);
    if (threadId) {
      await updateEscalation(escalation.id, { threadId });
    }
  } else if (escalation.projectId) {
    // Project-level escalation
    const { sendProjectEscalationEmail } = await import("./gmail");
    const projectTitle = (escalation.contextSnapshot.projectTitle as string) || escalation.projectId;
    const context = Object.keys(escalation.contextSnapshot).length > 0
      ? JSON.stringify(escalation.contextSnapshot, null, 2)
      : undefined;
    await sendProjectEscalationEmail({
      projectId: escalation.projectId,
      projectTitle,
      reason: escalation.reason,
      context,
      escalationType: "project",
    });
  }
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

  // Save the escalation record (audit trail — always created regardless of tier)
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
  }

  console.log(`[escalation] Created escalation ${id} for work item ${workItemId}: ${reason}`);

  // Classify and route to the appropriate tier handler
  const classification = classifyEscalation(reason, contextSnapshot);
  console.log(`[escalation] Classified as tier: ${classification.tier} for reason: "${reason.slice(0, 80)}"`);

  try {
    if (classification.tier === 'auto_resolve') {
      await handleAutoResolve(escalation, classification.action);
      await resolveEscalation(escalation.id, `Auto-resolved: ${classification.action.type}`);
      return escalation;
    }

    if (classification.tier === 'engineer') {
      await handleEngineerEscalation(escalation);
      await resolveEscalation(escalation.id, 'Auto-resolved: engineer work item filed');
      return escalation;
    }

    // product_owner tier
    await handleProductOwnerEscalation(escalation);
  } catch (err) {
    console.error(`[escalation] Auto-resolution failed for ${escalation.id}, promoting to product_owner:`, err);
    // Fallback: email the product owner
    try {
      await handleProductOwnerEscalation(escalation);
    } catch (emailErr) {
      console.error(`[escalation] Failed to send fallback product owner email:`, emailErr);
    }
  }

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
 * Resolve an escalation and unblock the associated work item
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

  // Unblock the work item so it re-enters the dispatch queue
  if (escalation.workItemId) {
    await unblockWorkItem(escalation.workItemId);
  }

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
 * Find a pending escalation for a given project and reason.
 * Returns the first matching pending escalation, or null if none exists.
 */
export async function findPendingProjectEscalation(
  projectId: string,
  reason: string
): Promise<Escalation | null> {
  const pending = await listEscalations("pending");
  return pending.find(
    (esc) => esc.projectId === projectId && esc.reason === reason
  ) ?? null;
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

/**
 * Escalate a fast-lane work item: transition status to 'escalated' and send email notification.
 */
export async function escalateFastLaneItem(
  workItemId: string,
  reason: EscalationReason,
  details: string
): Promise<void> {
  const workItem = await getWorkItem(workItemId);
  if (!workItem) {
    throw new Error(`Work item ${workItemId} not found`);
  }

  // Transition status to 'escalated'
  await updateWorkItem(workItemId, { status: 'escalated' });

  // Send escalation email
  const truncatedDescription = workItem.description.slice(0, 60);
  const subject = `[Agent Forge] Fast Lane Item Escalated: ${truncatedDescription}`;
  const reasonLabel = ESCALATION_REASON_LABELS[reason];

  const body = `
A fast-lane work item has been escalated and requires your attention.

Work Item ID: ${workItemId}
Target Repo: ${workItem.targetRepo}
Description: ${workItem.description}

Escalation Reason: ${reasonLabel}

Details:
${details}

---
Options:
- Retry as fast-lane: Update the item status back to 'ready' in the Agent Forge dashboard.
- Promote to full project: Create a new project in Notion and file a full work item with expanded scope.
- Dismiss: Mark as 'parked' if this item is no longer relevant.

View item: https://agent-forge.vercel.app/work-items/${workItemId}
`.trim();

  const { sendEmail } = await import('./gmail');
  await sendEmail({ subject, body });

  console.log(`[escalation] Fast-lane item ${workItemId} escalated: ${reason}`);
}
