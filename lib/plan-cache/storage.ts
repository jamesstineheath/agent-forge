// lib/plan-cache/storage.ts

import { loadJson, saveJson, deleteJson } from '../storage';
import type { PlanTemplate, PlanCacheIndex, PlanCacheIndexEntry } from './types';

const TEMPLATE_KEY_PREFIX = 'plan-cache/templates/';
const INDEX_KEY = 'plan-cache/index';

// ─── Template CRUD ────────────────────────────────────────────────────────────

/**
 * Persist a plan template to storage.
 * Also upserts the corresponding index entry.
 */
export async function savePlanTemplate(template: PlanTemplate): Promise<void> {
  await saveJson(`${TEMPLATE_KEY_PREFIX}${template.id}`, template);

  // Keep index in sync
  const index = await getPlanCacheIndex();
  const entry = templateToIndexEntry(template);
  const existing = index.findIndex((e) => e.id === template.id);
  if (existing >= 0) {
    index[existing] = entry;
  } else {
    index.push(entry);
  }
  await updatePlanCacheIndex(index);
}

/**
 * Retrieve a plan template by ID. Returns null if not found.
 */
export async function getPlanTemplate(id: string): Promise<PlanTemplate | null> {
  return loadJson<PlanTemplate>(`${TEMPLATE_KEY_PREFIX}${id}`);
}

/**
 * List all plan templates via the index, loading each full template.
 * For large caches, prefer using getPlanCacheIndex() for lightweight listing.
 */
export async function listPlanTemplates(): Promise<PlanTemplate[]> {
  const index = await getPlanCacheIndex();
  const templates = await Promise.all(
    index.map(async (entry) => {
      return loadJson<PlanTemplate>(`${TEMPLATE_KEY_PREFIX}${entry.id}`);
    })
  );
  return templates.filter((t): t is PlanTemplate => t !== null);
}

/**
 * Apply a partial update to an existing plan template.
 * No-ops if the template does not exist.
 */
export async function updatePlanTemplate(
  id: string,
  partial: Partial<PlanTemplate>
): Promise<void> {
  const existing = await getPlanTemplate(id);
  if (!existing) return;
  const updated: PlanTemplate = { ...existing, ...partial, id };
  await savePlanTemplate(updated);
}

/**
 * Delete a plan template and remove it from the index.
 */
export async function deletePlanTemplate(id: string): Promise<void> {
  await deleteJson(`${TEMPLATE_KEY_PREFIX}${id}`);

  const index = await getPlanCacheIndex();
  const filtered = index.filter((e) => e.id !== id);
  await updatePlanCacheIndex(filtered);
}

// ─── Index CRUD ───────────────────────────────────────────────────────────────

/**
 * Retrieve the plan cache index. Returns empty array if not yet created.
 */
export async function getPlanCacheIndex(): Promise<PlanCacheIndex> {
  const index = await loadJson<PlanCacheIndex>(INDEX_KEY);
  return index ?? [];
}

/**
 * Overwrite the plan cache index with the provided array.
 */
export async function updatePlanCacheIndex(index: PlanCacheIndex): Promise<void> {
  await saveJson(INDEX_KEY, index);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function templateToIndexEntry(template: PlanTemplate): PlanCacheIndexEntry {
  return {
    id: template.id,
    domainTags: template.domainTags,
    complexity: template.complexity,
    filePatterns: template.filePatterns,
    stepCount: template.templateSteps.length,
    usageCount: template.usageCount,
    successRate: template.performanceStats.successRate,
    createdAt: template.createdAt,
    lastUsedAt: template.lastUsedAt,
  };
}
