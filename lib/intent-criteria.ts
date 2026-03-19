/**
 * Intent Criteria — blob store, Notion parser, and import logic.
 *
 * Stores structured acceptance criteria in AF's blob store
 * for tracking pass/fail during pipeline execution.
 *
 * Criteria originate in Notion (written by the AC Agent),
 * are imported to AF when Status = "Approved", and are
 * updated by the Intent Validator (Phase 3) post-execution.
 */

import { loadJson, saveJson } from "./storage";
import type {
  Criterion,
  CriterionType,
  IntentCriteria,
  IntentCriteriaIndexEntry,
  CriterionStatus,
} from "./types";

// ── Constants ────────────────────────────────────────────────────────────────

const PRD_DATABASE_ID = "2a61cc49-73c5-41bf-981c-37ef1ab2f77b";
const NOTION_VERSION = "2022-06-28";
const INDEX_KEY = "intent-criteria/index";

// ── Notion API helpers ───────────────────────────────────────────────────────

async function notionFetch(path: string, method = "GET", body?: unknown) {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) throw new Error("NOTION_API_KEY not configured");

  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`https://api.notion.com/v1${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ── Notion block parsing ─────────────────────────────────────────────────────

interface NotionBlock {
  type: string;
  [key: string]: unknown;
}

interface RichTextItem {
  plain_text?: string;
  annotations?: { bold?: boolean; color?: string };
}

function extractRichText(richText: RichTextItem[]): string {
  if (!Array.isArray(richText)) return "";
  return richText.map((t) => t.plain_text || "").join("");
}

async function getPageBlocks(pageId: string): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    const params = cursor ? `?start_cursor=${cursor}` : "";
    const data = await notionFetch(`/blocks/${pageId}/children${params}`);
    blocks.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return blocks;
}

/**
 * Parse Notion blocks to extract structured criteria from the
 * "Acceptance Criteria" section written by the AC Agent.
 *
 * Expected format:
 * ## Acceptance Criteria
 * ### 🖥️ UI
 * - Description text  [✔ Testable | Est. cost: $3.00]
 * ### 🔌 API
 * - Description text  [✔ Testable | Est. cost: $5.00]
 */
function parseCriteriaFromBlocks(blocks: NotionBlock[]): Criterion[] {
  const criteria: Criterion[] = [];
  let inSection = false;
  let currentType: CriterionType = "api";
  let counter = 0;

  const typeMap: Record<string, CriterionType> = {
    ui: "ui",
    api: "api",
    data: "data",
    integration: "integration",
    performance: "performance",
  };

  for (const block of blocks) {
    const type = block.type as string;
    const content = block[type] as { rich_text?: RichTextItem[] } | undefined;

    // Detect "Acceptance Criteria" heading
    if ((type === "heading_1" || type === "heading_2") && content?.rich_text) {
      const text = extractRichText(content.rich_text).toLowerCase();
      if (text.includes("acceptance criteria")) {
        inSection = true;
        continue;
      }
      // Next heading of same or higher level ends the section
      if (inSection && type === "heading_2" && !text.includes("acceptance criteria")) {
        // Could be end of section or a different h2
        // Check if it's a type sub-heading (h3 handles those)
        break;
      }
    }

    if (!inSection) continue;

    // Detect type sub-headings (### 🖥️ UI, ### 🔌 API, etc.)
    if (type === "heading_3" && content?.rich_text) {
      const text = extractRichText(content.rich_text).toLowerCase();
      for (const [key, criterionType] of Object.entries(typeMap)) {
        if (text.includes(key)) {
          currentType = criterionType;
          break;
        }
      }
      continue;
    }

    // Parse list items as criteria (bulleted or numbered)
    if ((type === "bulleted_list_item" || type === "numbered_list_item") && content?.rich_text) {
      const fullText = extractRichText(content.rich_text);
      if (!fullText.trim()) continue;

      // Skip metadata lines like "Testable: Yes | Est. Cost: $12"
      if (fullText.match(/^\s*\*?\s*Testable:/i)) continue;

      counter++;

      // Extract type tag from text like "[DATA] description" or "[UI] description"
      const typeTagMatch = fullText.match(/^\[(\w+)\]\s*/);
      let criterionType = currentType;
      let cleanText = fullText;
      if (typeTagMatch) {
        const tag = typeTagMatch[1].toLowerCase();
        if (tag in typeMap) {
          criterionType = typeMap[tag];
        }
        cleanText = fullText.slice(typeTagMatch[0].length);
      }

      const { description, cost } = parseCriterionText(cleanText);

      criteria.push({
        id: `c-${String(counter).padStart(3, "0")}`,
        description,
        type: criterionType,
        estimatedCost: cost,
        status: "pending",
      });
      continue;
    }

    // Also check for metadata in paragraph/callout blocks following a criterion
    // Format: "Testable: Yes | Est. Cost: $12" or span with gray color
    if (inSection && (type === "paragraph" || type === "callout") && content?.rich_text) {
      const text = extractRichText(content.rich_text);
      const costMatch = text.match(/Est\.?\s*Cost:\s*\$?([\d.]+)/i);
      if (costMatch && criteria.length > 0) {
        // Update the most recent criterion's cost
        criteria[criteria.length - 1].estimatedCost = parseFloat(costMatch[1]) || 5;
      }
    }
  }

  return criteria;
}

/**
 * Parse a single criterion's text to extract description and cost.
 * Input: "Users can edit preferences and see updated scores  [✔ Testable | Est. cost: $5.00]"
 * Output: { description: "Users can edit preferences and see updated scores", cost: 5.0 }
 */
function parseCriterionText(text: string): { description: string; cost: number } {
  // Match the metadata suffix: [✔ Testable | Est. cost: $X.XX] or [⚠ Needs refinement | Est. cost: $X.XX]
  const metaMatch = text.match(/\s*\[.*?Est\.\s*cost:\s*\$?([\d.]+)\s*\]\s*$/);
  let cost = 5; // default
  let description = text;

  if (metaMatch) {
    cost = parseFloat(metaMatch[1]) || 5;
    description = text.slice(0, metaMatch.index).trim();
  }

  // Also try simpler format: just a trailing cost like "($5)"
  if (!metaMatch) {
    const simpleCost = text.match(/\s*\(\$?([\d.]+)\)\s*$/);
    if (simpleCost) {
      cost = parseFloat(simpleCost[1]) || 5;
      description = text.slice(0, simpleCost.index).trim();
    }
  }

  return { description, cost };
}

// ── PRD page property extraction ─────────────────────────────────────────────

interface PRDPageProperties {
  prdId: string;
  prdTitle: string;
  projectId?: string;
  targetRepo?: string;
  priority?: string;
  rank?: number;
  notionUrl: string;
}

function extractPRDProperties(page: { id: string; properties: Record<string, unknown>; url: string }): PRDPageProperties {
  const props = page.properties as Record<string, {
    title?: Array<{ plain_text?: string }>;
    rich_text?: Array<{ plain_text?: string }>;
    select?: { name?: string };
    number?: number | null;
  }>;

  return {
    prdId: page.id.replace(/-/g, ""),
    prdTitle: props["PRD Title"]?.title?.[0]?.plain_text || "Untitled",
    projectId: props["AF Project ID"]?.rich_text?.[0]?.plain_text || undefined,
    targetRepo: props["Target Repo"]?.select?.name || undefined,
    priority: props["Priority"]?.select?.name || undefined,
    rank: props["Rank"]?.number ?? undefined,
    notionUrl: `https://www.notion.so/${page.id.replace(/-/g, "")}`,
  };
}

// ── Blob store operations ────────────────────────────────────────────────────

function criteriaKey(prdId: string): string {
  return `intent-criteria/${prdId.replace(/-/g, "")}`;
}

export async function getCriteria(prdId: string): Promise<IntentCriteria | null> {
  return loadJson<IntentCriteria>(criteriaKey(prdId));
}

export async function listAllCriteria(): Promise<IntentCriteriaIndexEntry[]> {
  const index = await loadJson<IntentCriteriaIndexEntry[]>(INDEX_KEY);
  return index || [];
}

async function saveCriteria(criteria: IntentCriteria): Promise<void> {
  await saveJson(criteriaKey(criteria.prdId), criteria);
  await updateIndex(criteria);
}

async function updateIndex(criteria: IntentCriteria): Promise<void> {
  const index = (await loadJson<IntentCriteriaIndexEntry[]>(INDEX_KEY)) || [];

  const entry: IntentCriteriaIndexEntry = {
    prdId: criteria.prdId,
    prdTitle: criteria.prdTitle,
    projectId: criteria.projectId,
    targetRepo: criteria.targetRepo,
    criteriaCount: criteria.criteria.length,
    passedCount: criteria.passedCount,
    failedCount: criteria.failedCount,
    totalEstimatedCost: criteria.totalEstimatedCost,
    importedAt: criteria.importedAt,
  };

  const existingIdx = index.findIndex((e) => e.prdId === criteria.prdId);
  if (existingIdx >= 0) {
    index[existingIdx] = entry;
  } else {
    index.push(entry);
  }

  await saveJson(INDEX_KEY, index);
}

// ── Import from Notion ───────────────────────────────────────────────────────

/**
 * Import criteria from a single Notion PRD page into the AF blob store.
 */
export async function importCriteriaFromNotion(prdPageId: string): Promise<IntentCriteria> {
  // Fetch page properties
  const page = await notionFetch(`/pages/${prdPageId}`);
  const props = extractPRDProperties(page);

  // Fetch blocks and parse criteria
  const blocks = await getPageBlocks(prdPageId);
  const criteria = parseCriteriaFromBlocks(blocks);

  const totalEstimatedCost = criteria.reduce((sum, c) => sum + c.estimatedCost, 0);

  const intentCriteria: IntentCriteria = {
    prdId: props.prdId,
    prdTitle: props.prdTitle,
    projectId: props.projectId,
    targetRepo: props.targetRepo,
    priority: props.priority,
    rank: props.rank,
    criteria,
    importedAt: new Date().toISOString(),
    notionSyncedAt: new Date().toISOString(),
    totalEstimatedCost: Math.round(totalEstimatedCost * 100) / 100,
    passedCount: 0,
    failedCount: 0,
    notionUrl: props.notionUrl,
  };

  await saveCriteria(intentCriteria);
  return intentCriteria;
}

/**
 * Query the PRD database for Approved pages and import any
 * that haven't been imported yet (or are stale).
 */
export async function importAllApprovedCriteria(): Promise<{ imported: number; skipped: number }> {
  const body = {
    filter: {
      property: "Status",
      select: { equals: "Approved" },
    },
    page_size: 50,
  };

  const data = await notionFetch(`/databases/${PRD_DATABASE_ID}/query`, "POST", body);
  const pages = data.results || [];

  let imported = 0;
  let skipped = 0;

  for (const page of pages) {
    const prdId = (page.id as string).replace(/-/g, "");
    const existing = await getCriteria(prdId);

    // Skip if already imported and Notion hasn't been updated since
    if (existing) {
      const pageUpdated = new Date(page.last_edited_time as string).getTime();
      const lastSync = new Date(existing.notionSyncedAt).getTime();
      if (pageUpdated <= lastSync) {
        skipped++;
        continue;
      }
    }

    try {
      await importCriteriaFromNotion(page.id as string);
      imported++;
    } catch (err) {
      console.error(`[intent-criteria] Failed to import ${prdId}:`, err);
      skipped++;
    }
  }

  return { imported, skipped };
}

// ── Criterion status updates ─────────────────────────────────────────────────

/**
 * Update a single criterion's status. Used by Intent Validator (Phase 3).
 */
export async function updateCriterionStatus(
  prdId: string,
  criterionId: string,
  status: CriterionStatus,
  evidence?: string,
): Promise<IntentCriteria | null> {
  const criteria = await getCriteria(prdId);
  if (!criteria) return null;

  const criterion = criteria.criteria.find((c) => c.id === criterionId);
  if (!criterion) return null;

  criterion.status = status;
  if (evidence) criterion.evidence = evidence;
  if (status !== "pending") criterion.verifiedAt = new Date().toISOString();

  // Recompute counts
  criteria.passedCount = criteria.criteria.filter((c) => c.status === "passed").length;
  criteria.failedCount = criteria.criteria.filter((c) => c.status === "failed").length;

  await saveCriteria(criteria);

  // Sync counts back to Notion
  await syncCountsToNotion(prdId, criteria.passedCount, criteria.criteria.length);

  return criteria;
}

/**
 * Update Notion PRD page with criteria pass/fail counts.
 */
async function syncCountsToNotion(prdId: string, passedCount: number, totalCount: number): Promise<void> {
  try {
    const pageId = prdId.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
    await notionFetch(`/pages/${pageId}`, "PATCH", {
      properties: {
        "Criteria Passed": { number: passedCount },
        "Criteria Count": { number: totalCount },
      },
    });
  } catch (err) {
    console.warn(`[intent-criteria] Failed to sync counts to Notion for ${prdId}:`, err);
  }
}
