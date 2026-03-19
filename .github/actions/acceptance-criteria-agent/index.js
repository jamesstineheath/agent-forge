// Acceptance Criteria Agent
// Reads PRDs from Notion, generates structured testable acceptance criteria via Claude.
// Node.js, no transpilation. Uses Notion REST API directly and @anthropic-ai/sdk.

const Anthropic = require("@anthropic-ai/sdk");

// --- Configuration ---

const NOTION_DB_ID = "2a61cc49-73c5-41bf-981c-37ef1ab2f77b";
const NOTION_VERSION = "2022-06-28";
const CLAUDE_MODEL = "claude-opus-4-6";
const CRITERION_TYPES = ["ui", "api", "data", "integration", "performance"];

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const AGENT_FORGE_URL = process.env.AGENT_FORGE_URL;
const AGENT_FORGE_API_SECRET = process.env.AGENT_FORGE_API_SECRET;

// --- Notion helpers ---

async function notionFetch(path, method = "GET", body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
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

async function queryDatabase(filter) {
  return notionFetch(`/databases/${NOTION_DB_ID}/query`, "POST", { filter });
}

async function getPageBlocks(pageId) {
  const blocks = [];
  let cursor;
  do {
    const params = cursor ? `?start_cursor=${cursor}` : "";
    const data = await notionFetch(`/blocks/${pageId}/children${params}`);
    blocks.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return blocks;
}

async function appendBlocks(pageId, children) {
  return notionFetch(`/blocks/${pageId}/children`, "PATCH", { children });
}

async function updatePageProperties(pageId, properties) {
  return notionFetch(`/pages/${pageId}`, "PATCH", { properties });
}

async function getPageComments(pageId) {
  return notionFetch(`/comments?block_id=${pageId}`);
}

async function postComment(pageId, text) {
  return notionFetch("/comments", "POST", {
    parent: { page_id: pageId },
    rich_text: [{ type: "text", text: { content: text } }],
  });
}

// --- Block text extraction ---

function extractRichText(richTextArray) {
  if (!richTextArray) return "";
  return richTextArray.map((rt) => rt.plain_text || "").join("");
}

function blocksToText(blocks) {
  const lines = [];
  for (const block of blocks) {
    const type = block.type;
    if (type === "heading_1" || type === "heading_2" || type === "heading_3") {
      const prefix = "#".repeat(parseInt(type.slice(-1)));
      lines.push(`${prefix} ${extractRichText(block[type].rich_text)}`);
    } else if (type === "paragraph") {
      lines.push(extractRichText(block[type].rich_text));
    } else if (type === "bulleted_list_item") {
      lines.push(`- ${extractRichText(block[type].rich_text)}`);
    } else if (type === "numbered_list_item") {
      lines.push(`1. ${extractRichText(block[type].rich_text)}`);
    } else if (type === "code") {
      lines.push(`\`\`\`\n${extractRichText(block[type].rich_text)}\n\`\`\``);
    } else if (type === "toggle") {
      lines.push(`> ${extractRichText(block[type].rich_text)}`);
    } else if (type === "callout") {
      lines.push(`> ${extractRichText(block[type].rich_text)}`);
    } else if (type === "quote") {
      lines.push(`> ${extractRichText(block[type].rich_text)}`);
    } else if (type === "divider") {
      lines.push("---");
    }
  }
  return lines.join("\n");
}

function hasAcceptanceCriteriaSection(blocks) {
  return blocks.some((block) => {
    const type = block.type;
    if (type === "heading_1" || type === "heading_2" || type === "heading_3") {
      const text = extractRichText(block[type].rich_text).trim();
      return text.toLowerCase() === "acceptance criteria";
    }
    return false;
  });
}

// --- Claude integration ---

function buildCriteriaPrompt(prdText) {
  return {
    system: `You are an expert product analyst. Given a PRD (Product Requirements Document), generate structured, testable acceptance criteria.

Each criterion MUST have:
- "description": A concrete, measurable statement. NOT vague like "system should work well". GOOD examples:
  - "API endpoint /api/users returns 200 with JSON array of user objects containing id, name, email fields"
  - "Dashboard loads within 2 seconds on 3G connection with 1000 data points"
  - "Clicking 'Submit' with empty required fields shows inline validation errors for each field"
- "type": One of: "ui", "api", "data", "integration", "performance"
- "testable": Boolean, must be true. If you cannot make it testable, rewrite until it is.
- "estimated_cost": Estimated implementation cost in USD (rough order of magnitude)

Return a JSON array of criteria objects. Return ONLY the JSON array, no markdown fences or explanation.`,
    user: `Generate acceptance criteria for this PRD:\n\n${prdText}`,
  };
}

function buildRevisionPrompt(prdText, currentCriteria, feedback) {
  return {
    system: `You are an expert product analyst. You previously generated acceptance criteria for a PRD. The PM has provided feedback via comments. Revise the criteria incorporating the feedback.

Each criterion MUST have:
- "description": Concrete, measurable statement
- "type": One of: "ui", "api", "data", "integration", "performance"
- "testable": Boolean (must be true)
- "estimated_cost": Estimated implementation cost in USD

Return a JSON array of criteria objects. Return ONLY the JSON array, no markdown fences or explanation.`,
    user: `PRD:\n${prdText}\n\nCurrent criteria:\n${JSON.stringify(currentCriteria, null, 2)}\n\nFeedback to incorporate:\n${feedback}`,
  };
}

async function callClaude(anthropic, systemPrompt, userPrompt) {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  // Parse JSON with fallbacks
  try {
    return JSON.parse(text);
  } catch {
    // Try extracting from markdown code block
    const codeMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeMatch) return JSON.parse(codeMatch[1].trim());
    // Try extracting raw JSON array
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) return JSON.parse(arrayMatch[0]);
    throw new Error(`Failed to parse Claude response as JSON: ${text.slice(0, 200)}`);
  }
}

function validateCriteria(criteria) {
  if (!Array.isArray(criteria)) throw new Error("Criteria must be an array");
  return criteria.map((c) => ({
    description: String(c.description || ""),
    type: CRITERION_TYPES.includes(c.type) ? c.type : "api",
    testable: Boolean(c.testable),
    estimated_cost: typeof c.estimated_cost === "number" ? c.estimated_cost : 0,
  }));
}

// --- Notion block builders ---

function buildCriteriaBlocks(criteria) {
  const children = [
    {
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: "Acceptance Criteria" } }],
      },
    },
  ];

  for (let i = 0; i < criteria.length; i++) {
    const c = criteria[i];
    children.push({
      object: "block",
      type: "numbered_list_item",
      numbered_list_item: {
        rich_text: [
          {
            type: "text",
            text: { content: `[${c.type.toUpperCase()}] ${c.description}` },
            annotations: { bold: false },
          },
        ],
      },
    });
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content: `   Testable: ${c.testable ? "Yes" : "No"} | Est. Cost: $${c.estimated_cost}`,
            },
            annotations: { italic: true, color: "gray" },
          },
        ],
      },
    });
  }

  return children;
}

// --- Delete existing criteria section (for revisions) ---

async function deleteAcceptanceCriteriaSection(blocks) {
  let inSection = false;
  const toDelete = [];

  for (const block of blocks) {
    const type = block.type;
    if (
      (type === "heading_1" || type === "heading_2" || type === "heading_3") &&
      extractRichText(block[type].rich_text).trim().toLowerCase() === "acceptance criteria"
    ) {
      inSection = true;
      toDelete.push(block.id);
      continue;
    }
    // Stop when we hit the next heading of same or higher level
    if (inSection) {
      if (type === "heading_1" || type === "heading_2") {
        break;
      }
      toDelete.push(block.id);
    }
  }

  for (const blockId of toDelete) {
    await notionFetch(`/blocks/${blockId}`, "DELETE");
  }
}

// --- Extract existing criteria from blocks (for revision context) ---

function extractExistingCriteria(blocks) {
  const criteria = [];
  let inSection = false;

  for (const block of blocks) {
    const type = block.type;
    if (
      (type === "heading_1" || type === "heading_2" || type === "heading_3") &&
      extractRichText(block[type].rich_text).trim().toLowerCase() === "acceptance criteria"
    ) {
      inSection = true;
      continue;
    }
    if (inSection && (type === "heading_1" || type === "heading_2")) {
      break;
    }
    if (inSection && type === "numbered_list_item") {
      const text = extractRichText(block[type].rich_text);
      const typeMatch = text.match(/^\[(\w+)\]\s*/);
      criteria.push({
        description: typeMatch ? text.slice(typeMatch[0].length) : text,
        type: typeMatch ? typeMatch[1].toLowerCase() : "api",
        testable: true,
        estimated_cost: 0,
      });
    }
  }
  return criteria;
}

// --- Escalation ---

async function escalate(reason, context = {}) {
  if (!AGENT_FORGE_URL || !AGENT_FORGE_API_SECRET) {
    console.error(`[Escalation] Cannot escalate (missing config): ${reason}`);
    return;
  }
  try {
    const res = await fetch(`${AGENT_FORGE_URL}/api/escalations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AGENT_FORGE_API_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reason,
        confidenceScore: 0.5,
        contextSnapshot: { agent: "acceptance-criteria-agent", ...context },
      }),
    });
    if (!res.ok) {
      console.error(`[Escalation] API returned ${res.status}: ${await res.text()}`);
    } else {
      console.log(`[Escalation] Created escalation for: ${reason}`);
    }
  } catch (err) {
    console.error(`[Escalation] Failed to escalate: ${err.message}`);
  }
}

// --- Main ---

async function main() {
  console.log("[AcceptanceCriteriaAgent] Starting run...");

  if (!NOTION_API_KEY) throw new Error("NOTION_API_KEY is required");
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // Query for Draft and In Review pages
  const draftPages = await queryDatabase({
    property: "Status",
    select: { equals: "Draft" },
  });

  const inReviewPages = await queryDatabase({
    property: "Status",
    select: { equals: "In Review" },
  });

  const allPages = [...draftPages.results, ...inReviewPages.results];
  console.log(
    `[AcceptanceCriteriaAgent] Found ${draftPages.results.length} Draft and ${inReviewPages.results.length} In Review pages`
  );

  if (allPages.length === 0) {
    console.log("[AcceptanceCriteriaAgent] No pages to process. Done.");
    return;
  }

  for (const page of allPages) {
    const pageId = page.id;
    const title =
      page.properties?.Name?.title?.[0]?.plain_text ||
      page.properties?.Title?.title?.[0]?.plain_text ||
      pageId;
    const status = page.properties?.Status?.select?.name;

    console.log(`[AcceptanceCriteriaAgent] Processing "${title}" (${status})`);

    try {
      const blocks = await getPageBlocks(pageId);

      if (status === "Draft") {
        await handleDraftPage(anthropic, pageId, title, blocks);
      } else if (status === "In Review") {
        await handleInReviewPage(anthropic, pageId, title, blocks, page);
      }
    } catch (err) {
      console.error(`[AcceptanceCriteriaAgent] Error processing "${title}": ${err.message}`);
      await escalate(`Failed to process PRD "${title}": ${err.message}`, {
        pageId,
        title,
        error: err.message,
      });
    }
  }

  console.log("[AcceptanceCriteriaAgent] Run complete.");
}

async function handleDraftPage(anthropic, pageId, title, blocks) {
  // Skip if already has acceptance criteria section
  if (hasAcceptanceCriteriaSection(blocks)) {
    console.log(`[AcceptanceCriteriaAgent] "${title}" already has criteria, skipping.`);
    return;
  }

  const prdText = blocksToText(blocks);
  if (!prdText.trim()) {
    console.log(`[AcceptanceCriteriaAgent] "${title}" has no content, skipping.`);
    return;
  }

  // Generate criteria via Claude
  const prompt = buildCriteriaPrompt(prdText);
  console.log(`[AcceptanceCriteriaAgent] Generating criteria for "${title}"...`);
  const rawCriteria = await callClaude(anthropic, prompt.system, prompt.user);
  const criteria = validateCriteria(rawCriteria);

  console.log(`[AcceptanceCriteriaAgent] Generated ${criteria.length} criteria for "${title}"`);

  // Append criteria section to page
  const criteriaBlocks = buildCriteriaBlocks(criteria);
  await appendBlocks(pageId, criteriaBlocks);

  // Update page properties
  const totalCost = criteria.reduce((sum, c) => sum + c.estimated_cost, 0);
  await updatePageProperties(pageId, {
    Status: { select: { name: "In Review" } },
    "Criteria Count": { number: criteria.length },
    "Estimated Cost": { number: totalCost },
  });

  // Post agent marker comment
  await postComment(pageId, `[Agent] Generated ${criteria.length} acceptance criteria. Total estimated cost: $${totalCost}. Please review and comment with any feedback.`);

  console.log(`[AcceptanceCriteriaAgent] "${title}" moved to In Review.`);
}

async function handleInReviewPage(anthropic, pageId, title, blocks, page) {
  // Must already have acceptance criteria
  if (!hasAcceptanceCriteriaSection(blocks)) {
    console.log(`[AcceptanceCriteriaAgent] "${title}" is In Review but has no criteria, skipping.`);
    return;
  }

  // Check for unprocessed comments (after last [Agent] marker)
  const commentsResponse = await getPageComments(pageId);
  const comments = commentsResponse.results || [];

  // Find last agent marker comment
  let lastAgentIdx = -1;
  for (let i = comments.length - 1; i >= 0; i--) {
    const text = extractRichText(comments[i].rich_text);
    if (text.startsWith("[Agent]")) {
      lastAgentIdx = i;
      break;
    }
  }

  // Collect comments after the last agent marker
  const unprocessedComments = comments
    .slice(lastAgentIdx + 1)
    .map((c) => extractRichText(c.rich_text))
    .filter((t) => t.trim() && !t.startsWith("[Agent]"));

  if (unprocessedComments.length === 0) {
    console.log(`[AcceptanceCriteriaAgent] "${title}" has no new feedback, skipping.`);
    return;
  }

  console.log(
    `[AcceptanceCriteriaAgent] "${title}" has ${unprocessedComments.length} unprocessed comments, revising...`
  );

  const prdText = blocksToText(blocks);
  const existingCriteria = extractExistingCriteria(blocks);
  const feedback = unprocessedComments.join("\n\n");

  // Revise criteria via Claude
  const prompt = buildRevisionPrompt(prdText, existingCriteria, feedback);
  const rawCriteria = await callClaude(anthropic, prompt.system, prompt.user);
  const criteria = validateCriteria(rawCriteria);

  console.log(`[AcceptanceCriteriaAgent] Revised to ${criteria.length} criteria for "${title}"`);

  // Replace criteria section
  await deleteAcceptanceCriteriaSection(blocks);
  const criteriaBlocks = buildCriteriaBlocks(criteria);
  await appendBlocks(pageId, criteriaBlocks);

  // Update properties
  const totalCost = criteria.reduce((sum, c) => sum + c.estimated_cost, 0);
  const currentRounds = page.properties?.["Review Rounds"]?.number || 0;
  await updatePageProperties(pageId, {
    "Criteria Count": { number: criteria.length },
    "Estimated Cost": { number: totalCost },
    "Review Rounds": { number: currentRounds + 1 },
  });

  // Post new agent marker
  await postComment(
    pageId,
    `[Agent] Revised criteria based on ${unprocessedComments.length} comment(s). Now ${criteria.length} criteria, est. cost: $${totalCost}. Please review.`
  );
}

main().catch(async (err) => {
  console.error(`[AcceptanceCriteriaAgent] Fatal error: ${err.message}`);
  await escalate(`Agent fatal error: ${err.message}`, { stack: err.stack });
  process.exit(1);
});
