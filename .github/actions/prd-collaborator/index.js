// PRD Collaborator Agent
// Reads PRDs from Notion, provides strategic product feedback as comments.
// Shares PM memory with the HITL chat PM on claude.ai.

const Anthropic = require("@anthropic-ai/sdk");

// --- Configuration ---

const NOTION_VERSION = "2022-06-28";
const PRD_DATABASE_ID = "2a61cc49-73c5-41bf-981c-37ef1ab2f77b";
const CLAUDE_MODEL = "claude-sonnet-4-5-20241022";

// PM memory pages (shared with HITL PM chat)
const PM_MEMORY_PAGES = {
  masterSession: "30c041760b7081b88df2f1ce7fb30c19",
  agentForgeSession: "323041760b7081cda23bddb9f8650108",
  workingNorms: "31f041760b70813e8199d4d2ee7a384c",
};

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DRY_RUN = process.env.DRY_RUN === "true";

const AGENT_TAG = "[PRD Collaborator]";

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

function extractRichText(richText) {
  if (!Array.isArray(richText)) return "";
  return richText.map((t) => t.plain_text || "").join("");
}

function blocksToText(blocks) {
  const lines = [];
  for (const block of blocks) {
    const content = block[block.type];
    if (content?.rich_text) {
      const text = extractRichText(content.rich_text);
      if (text.trim()) lines.push(text);
    }
  }
  return lines.join("\n");
}

async function getPageComments(pageId) {
  const data = await notionFetch(`/comments?block_id=${pageId}`);
  return data.results || [];
}

async function postComment(pageId, text) {
  return notionFetch("/comments", "POST", {
    parent: { page_id: pageId },
    rich_text: [
      {
        type: "text",
        text: { content: text },
      },
    ],
  });
}

// --- PM Memory ---

async function loadPMMemory() {
  const memory = {};
  for (const [key, pageId] of Object.entries(PM_MEMORY_PAGES)) {
    try {
      const blocks = await getPageBlocks(pageId);
      memory[key] = blocksToText(blocks);
    } catch (err) {
      console.warn(`[PRDCollaborator] Could not read PM memory page "${key}": ${err.message}`);
      memory[key] = "(unavailable)";
    }
  }
  return memory;
}

// --- PRD Processing ---

async function queryPRDsNeedingFeedback() {
  const body = {
    filter: {
      or: [
        { property: "Status", select: { equals: "Needs PM" } },
        { property: "Status", select: { equals: "Draft" } },
      ],
    },
    sorts: [{ property: "Rank", direction: "ascending" }],
    page_size: 20,
  };

  const data = await notionFetch(`/databases/${PRD_DATABASE_ID}/query`, "POST", body);
  return data.results || [];
}

function getPageTitle(page) {
  const titleProp = page.properties?.["PRD Title"];
  if (titleProp?.title?.[0]?.plain_text) return titleProp.title[0].plain_text;
  return page.id;
}

function hasUnprocessedPMComments(comments) {
  // Find PM comments that don't have a subsequent agent response
  const pmComments = comments.filter(
    (c) => !extractRichText(c.rich_text || []).startsWith(AGENT_TAG)
  );
  const agentComments = comments.filter(
    (c) => extractRichText(c.rich_text || []).startsWith(AGENT_TAG)
  );

  if (pmComments.length === 0) return false;

  // If PM commented after the last agent comment, there's unprocessed feedback
  const lastPM = pmComments[pmComments.length - 1];
  const lastAgent = agentComments[agentComments.length - 1];

  if (!lastAgent) return true; // Agent never commented, PM has
  return new Date(lastPM.created_time) > new Date(lastAgent.created_time);
}

function extractPMFeedback(comments) {
  return comments
    .filter((c) => !extractRichText(c.rich_text || []).startsWith(AGENT_TAG))
    .map((c) => extractRichText(c.rich_text || []))
    .filter((t) => t.trim().length > 0);
}

// --- Claude ---

async function generateFeedback(anthropic, prdTitle, prdText, pmMemory, pmComments) {
  const hasComments = pmComments && pmComments.length > 0;

  const systemPrompt = `You are a senior product collaborator helping a technical PM refine PRDs for an autonomous dev pipeline (Agent Forge).

CONTEXT FROM PM MEMORY:
Working Norms: ${pmMemory.workingNorms || "(none)"}
Current Session Context: ${pmMemory.agentForgeSession || "(none)"}

YOUR ROLE:
- Challenge vague requirements. Ask "what does success look like?" and "how would you test this?"
- Suggest scope cuts when a PRD is too ambitious. Reference historical project costs if relevant.
- Flag missing dependencies, prerequisites, or pre-flight manual steps.
- Connect PRDs to each other: "this overlaps with the Travel Agent PRD" or "this depends on Repo Bootstrapper shipping first."
- Be direct and concise. The PM hates filler. No affirmations, no em dashes.
- Write for a technical PM, not an engineer. Focus on product outcomes, user value, and feasibility.
- If the PRD looks solid and complete, say so briefly and suggest it's ready for acceptance criteria generation (Status: Draft triggers the AC Agent).

YOUR TONE:
- Collaborative but challenging. Push back where appropriate.
- 3-5 sentences max per comment. Don't write essays.
- Ask 1-2 specific questions, not a laundry list.

${hasComments ? "The PM has left comments on this PRD. Address their specific feedback and questions. Don't repeat points they've already resolved." : "This is your first look at this PRD. Provide initial strategic feedback."}

Return ONLY the comment text. No JSON, no markdown fences. Start your response with the substance, not a greeting.`;

  let userContent = `PRD: "${prdTitle}"\n\n${prdText || "(empty PRD, no content yet)"}`;

  if (hasComments) {
    userContent += `\n\nPM Comments to address:\n${pmComments.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;
  }

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  });

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

// --- Main ---

async function main() {
  console.log(`[PRDCollaborator] Starting run... (dry_run: ${DRY_RUN})`);

  if (!ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY");
  if (!NOTION_API_KEY) throw new Error("Missing NOTION_API_KEY");

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // Load PM memory (shared with HITL chat)
  console.log("[PRDCollaborator] Loading PM memory pages...");
  const pmMemory = await loadPMMemory();
  console.log(
    `[PRDCollaborator] PM memory loaded: masterSession=${pmMemory.masterSession?.length || 0} chars, ` +
    `agentForgeSession=${pmMemory.agentForgeSession?.length || 0} chars, ` +
    `workingNorms=${pmMemory.workingNorms?.length || 0} chars`
  );

  // Query Draft PRDs
  const pages = await queryPRDsNeedingFeedback();
  console.log(`[PRDCollaborator] Found ${pages.length} PRD(s) needing feedback (Needs PM + Draft).`);

  if (pages.length === 0) {
    console.log("[PRDCollaborator] Nothing to process. Done.");
    return;
  }

  let processed = 0;
  let skipped = 0;

  for (const page of pages) {
    const pageId = page.id;
    const title = getPageTitle(page);

    console.log(`\n[PRDCollaborator] Checking "${title}"...`);

    try {
      // Get page content
      const blocks = await getPageBlocks(pageId);
      const prdText = blocksToText(blocks);

      if (!prdText.trim()) {
        console.log(`[PRDCollaborator] "${title}" has no content. Skipping.`);
        skipped++;
        continue;
      }

      // Check comments
      const comments = await getPageComments(pageId);
      const hasUnprocessed = hasUnprocessedPMComments(comments);

      // Skip if we already commented and PM hasn't responded
      if (!hasUnprocessed && comments.some((c) => extractRichText(c.rich_text || []).startsWith(AGENT_TAG))) {
        console.log(`[PRDCollaborator] "${title}" waiting for PM response. Skipping.`);
        skipped++;
        continue;
      }

      // Generate feedback
      const pmFeedback = hasUnprocessed ? extractPMFeedback(comments) : null;
      const feedback = await generateFeedback(anthropic, title, prdText, pmMemory, pmFeedback);

      if (!feedback) {
        console.log(`[PRDCollaborator] No feedback generated for "${title}". Skipping.`);
        skipped++;
        continue;
      }

      const commentText = `${AGENT_TAG} ${feedback}`;

      if (DRY_RUN) {
        console.log(`[PRDCollaborator] [DRY RUN] Would comment on "${title}":\n${commentText}`);
      } else {
        await postComment(pageId, commentText);
        console.log(`[PRDCollaborator] Posted comment on "${title}".`);
      }

      processed++;

      // Rate limit: 400ms between pages
      await new Promise((r) => setTimeout(r, 400));
    } catch (err) {
      console.error(`[PRDCollaborator] Error processing "${title}": ${err.message}`);
    }
  }

  console.log(`\n[PRDCollaborator] Done. Processed: ${processed}, Skipped: ${skipped}.`);
}

main().catch((err) => {
  console.error(`[PRDCollaborator] Fatal error: ${err.message}`);
  process.exit(1);
});
