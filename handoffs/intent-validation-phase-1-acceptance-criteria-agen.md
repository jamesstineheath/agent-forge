<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Intent Validation Phase 1: Acceptance Criteria Agent

## Metadata
- **Branch:** `feat/acceptance-criteria-agent`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** .github/workflows/acceptance-criteria-agent.yml, .github/actions/acceptance-criteria-agent/action.yml, .github/actions/acceptance-criteria-agent/index.js

## Context

Agent Forge orchestrates autonomous agent teams. The PM Agent currently decomposes Notion project plans into work items. However, there's no validation layer between "someone wrote a PRD" and "work gets executed" — PRDs can be vague, incomplete, or lacking testable acceptance criteria.

This task builds the **Acceptance Criteria Agent**: a GitHub Actions-based TLM agent that reads PRDs from the Notion "PRDs & Acceptance Criteria" database and generates structured, testable acceptance criteria using Claude. It follows the same composite action pattern used by other TLM agents in this repo (e.g., `tlm-outcome-tracker`, `tlm-feedback-compiler`).

The agent is PM-centric: the PM stays in Notion, comments on criteria inline, and sets statuses. The agent handles all read/write automation invisibly in the background.

**Existing patterns to follow:**
- Composite actions in `.github/actions/<name>/action.yml` with `index.js` for logic
- Workflow files in `.github/workflows/` with cron + `workflow_dispatch`
- Notion API calls via `lib/notion.ts` patterns (REST API with `NOTION_API_KEY`)
- Claude API usage via `@anthropic-ai/sdk`
- Escalation via `POST ${AGENT_FORGE_URL}/api/escalations`

**Notion database ID:** `04216ec5-2206-4753-9063-d058f636cb46`

**PRD page properties expected:**
- `Status` (select): "Draft" → "In Review" → "Approved"
- `Criteria Count` (number): count of generated criteria
- `Review Rounds` (number): how many times criteria have been revised based on comments
- `Estimated Cost` (number): sum of per-criterion cost estimates

## Requirements

1. Create `.github/workflows/acceptance-criteria-agent.yml` with a 30-minute cron schedule and `workflow_dispatch` trigger
2. Create `.github/actions/acceptance-criteria-agent/action.yml` as a composite action that accepts `anthropic-api-key`, `notion-api-key`, `agent-forge-url`, and `agent-forge-api-secret` as inputs
3. Create `.github/actions/acceptance-criteria-agent/index.js` containing all agent logic (Node.js, no transpilation)
4. Agent queries the Notion database `04216ec5-2206-4753-9063-d058f636cb46` for pages with Status = "Draft"
5. For each Draft PRD, agent reads page content blocks to extract the PRD body text
6. Agent skips PRDs that already have an "Acceptance Criteria" section (detected by searching for a heading block with that text)
7. Agent calls Claude to generate structured acceptance criteria from the PRD content
8. Each criterion must have: `description` (string), `type` (one of: `ui`, `api`, `data`, `integration`, `performance`), `testable` (boolean), `estimated_cost` (number in USD)
9. Criteria descriptions must be concrete and measurable (not vague); Claude prompt enforces this with examples
10. Agent appends a well-formatted "Acceptance Criteria" section to the PRD page using Notion block API
11. Agent updates page properties: Status → "In Review", Criteria Count → number of criteria, Estimated Cost → sum of estimated costs
12. On subsequent runs, for Draft/In-Review PRDs that already have acceptance criteria, agent reads Notion page comments and checks for unprocessed feedback
13. If unprocessed comments exist, Claude regenerates/adjusts criteria incorporating the feedback, updates the page content, and increments Review Rounds
14. Agent skips pages with Status = "Approved" (criteria frozen)
15. On unrecoverable errors, agent calls the Agent Forge escalation API
16. All Notion API calls use the official REST API (not an SDK) with `Authorization: Bearer ${NOTION_API_KEY}` and `Notion-Version: 2022-06-28` headers

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/acceptance-criteria-agent
```

### Step 1: Create the GitHub Actions workflow file

Create `.github/workflows/acceptance-criteria-agent.yml`:

```yaml
name: Acceptance Criteria Agent

on:
  schedule:
    - cron: '*/30 * * * *'
  workflow_dispatch:

jobs:
  run-agent:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run Acceptance Criteria Agent
        uses: ./.github/actions/acceptance-criteria-agent
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          notion-api-key: ${{ secrets.NOTION_API_KEY }}
          agent-forge-url: ${{ secrets.AGENT_FORGE_URL }}
          agent-forge-api-secret: ${{ secrets.AGENT_FORGE_API_SECRET }}
```

### Step 2: Create the composite action definition

Create `.github/actions/acceptance-criteria-agent/action.yml`:

```yaml
name: Acceptance Criteria Agent
description: Reads PRDs from Notion, generates structured acceptance criteria using Claude, and posts them back to Notion.

inputs:
  anthropic-api-key:
    description: Anthropic API key for Claude
    required: true
  notion-api-key:
    description: Notion API key
    required: true
  agent-forge-url:
    description: Agent Forge deployment URL for escalations
    required: true
  agent-forge-api-secret:
    description: Agent Forge API secret for escalation callbacks
    required: true

runs:
  using: composite
  steps:
    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '20'

    - name: Install dependencies
      shell: bash
      working-directory: .github/actions/acceptance-criteria-agent
      run: npm install

    - name: Run agent
      shell: bash
      working-directory: .github/actions/acceptance-criteria-agent
      env:
        ANTHROPIC_API_KEY: ${{ inputs.anthropic-api-key }}
        NOTION_API_KEY: ${{ inputs.notion-api-key }}
        AGENT_FORGE_URL: ${{ inputs.agent-forge-url }}
        AGENT_FORGE_API_SECRET: ${{ inputs.agent-forge-api-secret }}
      run: node index.js
```

### Step 3: Create package.json for the action

Create `.github/actions/acceptance-criteria-agent/package.json`:

```json
{
  "name": "acceptance-criteria-agent",
  "version": "1.0.0",
  "description": "Generates structured acceptance criteria from Notion PRDs using Claude",
  "main": "index.js",
  "dependencies": {
    "@anthropic-ai/sdk": "^0.20.0"
  }
}
```

### Step 4: Create the main agent logic

Create `.github/actions/acceptance-criteria-agent/index.js` with the following structure and logic:

```javascript
#!/usr/bin/env node
'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// ── Constants ──────────────────────────────────────────────────────────────
const NOTION_VERSION = '2022-06-28';
const NOTION_BASE = 'https://api.notion.com/v1';
const PRD_DATABASE_ID = '04216ec5-2206-4753-9063-d058f636cb46';

const {
  ANTHROPIC_API_KEY,
  NOTION_API_KEY,
  AGENT_FORGE_URL,
  AGENT_FORGE_API_SECRET,
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── Notion API helpers ──────────────────────────────────────────────────────

async function notionRequest(method, path, body = null) {
  const url = `${NOTION_BASE}${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// Query database for Draft and In-Review PRDs
async function queryPRDs() {
  const results = [];
  let cursor = undefined;

  do {
    const body = {
      filter: {
        or: [
          { property: 'Status', select: { equals: 'Draft' } },
          { property: 'Status', select: { equals: 'In Review' } },
        ],
      },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };

    const data = await notionRequest('POST', `/databases/${PRD_DATABASE_ID}/query`, body);
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return results;
}

// Get all blocks for a page (paginated)
async function getPageBlocks(pageId) {
  const blocks = [];
  let cursor = undefined;

  do {
    const qs = cursor ? `?start_cursor=${cursor}` : '';
    const data = await notionRequest('GET', `/blocks/${pageId}/children${qs}`);
    blocks.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return blocks;
}

// Get page comments
async function getPageComments(pageId) {
  const data = await notionRequest('GET', `/comments?block_id=${pageId}`);
  return data.results || [];
}

// Extract plain text from a Notion rich_text array
function richTextToPlain(richTextArr) {
  if (!Array.isArray(richTextArr)) return '';
  return richTextArr.map(t => t.plain_text || '').join('');
}

// Extract full PRD text content from blocks
function extractPRDText(blocks) {
  const lines = [];
  for (const block of blocks) {
    const type = block.type;
    const content = block[type];
    if (!content) continue;

    if (content.rich_text) {
      const text = richTextToPlain(content.rich_text);
      if (text.trim()) lines.push(text);
    }
  }
  return lines.join('\n');
}

// Check if page already has an Acceptance Criteria section
function hasAcceptanceCriteriaSection(blocks) {
  return blocks.some(block => {
    const type = block.type;
    if (!type.startsWith('heading_')) return false;
    const content = block[type];
    if (!content?.rich_text) return false;
    const text = richTextToPlain(content.rich_text).toLowerCase();
    return text.includes('acceptance criteria');
  });
}

// Find the block ID of the Acceptance Criteria heading (to target comments)
function findAcceptanceCriteriaHeadingId(blocks) {
  for (const block of blocks) {
    const type = block.type;
    if (!type.startsWith('heading_')) continue;
    const content = block[type];
    if (!content?.rich_text) continue;
    const text = richTextToPlain(content.rich_text).toLowerCase();
    if (text.includes('acceptance criteria')) return block.id;
  }
  return null;
}

// Update page properties
async function updatePageProperties(pageId, props) {
  return notionRequest('PATCH', `/pages/${pageId}`, { properties: props });
}

// Append blocks to a page
async function appendBlocks(pageId, children) {
  return notionRequest('PATCH', `/blocks/${pageId}/children`, { children });
}

// Delete a block (used to clear old acceptance criteria section before rewriting)
async function deleteBlock(blockId) {
  return notionRequest('DELETE', `/blocks/${blockId}`);
}

// ── Claude helpers ──────────────────────────────────────────────────────────

async function generateAcceptanceCriteria(prdTitle, prdText, priorCriteria = null, comments = null) {
  const systemPrompt = `You are an expert software QA engineer and product manager specializing in writing testable acceptance criteria.

Your job is to read a Product Requirements Document (PRD) and produce structured acceptance criteria that:
- Are CONCRETE and MEASURABLE, never vague
- BAD: "the page loads fast" → GOOD: "the page initial load completes in under 3 seconds on a 4G connection"
- BAD: "users can manage their account" → GOOD: "user can update email address and receive a verification email within 60 seconds"
- Cover UI, API, data, integration, and performance aspects as appropriate
- Are independently verifiable (a QA engineer can write a test for each one)

Return ONLY valid JSON. No markdown fences, no explanation. Format:
{
  "criteria": [
    {
      "description": "string — concrete, measurable assertion",
      "type": "ui|api|data|integration|performance",
      "testable": true|false,
      "estimated_cost": 0.5
    }
  ],
  "summary": "1-2 sentence summary of what was generated"
}

Cost estimation guide (USD):
- Simple UI assertion (button visible, text present): $0.25
- API endpoint behavior: $0.50
- Data validation rule: $0.25
- Integration flow (end-to-end user action): $1.00
- Performance threshold: $0.75
- Complex multi-step scenario: $1.50–$3.00`;

  let userContent = `PRD Title: ${prdTitle}\n\nPRD Content:\n${prdText || '(no content provided)'}`;

  if (priorCriteria && comments && comments.length > 0) {
    const commentTexts = comments
      .map(c => {
        const text = c.rich_text ? richTextToPlain(c.rich_text) : '';
        return `- ${text}`;
      })
      .filter(t => t.trim() !== '-')
      .join('\n');

    userContent += `\n\nExisting Acceptance Criteria (to be revised):\n${priorCriteria}\n\nPM Feedback Comments:\n${commentTexts}\n\nPlease revise the criteria incorporating the PM feedback above.`;
  }

  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 4096,
    messages: [{ role: 'user', content: userContent }],
    system: systemPrompt,
  });

  const raw = msg.content[0].text.trim();
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Try to extract JSON from response
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Claude returned non-JSON: ${raw.slice(0, 200)}`);
  }
}

// ── Notion block builders ───────────────────────────────────────────────────

function buildAcceptanceCriteriaBlocks(criteria, summary) {
  const blocks = [];

  // Divider before section
  blocks.push({ object: 'block', type: 'divider', divider: {} });

  // Heading
  blocks.push({
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{ type: 'text', text: { content: 'Acceptance Criteria' } }],
    },
  });

  // Summary callout
  if (summary) {
    blocks.push({
      object: 'block',
      type: 'callout',
      callout: {
        rich_text: [{ type: 'text', text: { content: summary } }],
        icon: { type: 'emoji', emoji: '✅' },
      },
    });
  }

  // Type labels
  const typeEmoji = {
    ui: '🖥️',
    api: '🔌',
    data: '🗄️',
    integration: '🔗',
    performance: '⚡',
  };

  // Group criteria by type
  const byType = {};
  for (const c of criteria) {
    const t = c.type || 'api';
    if (!byType[t]) byType[t] = [];
    byType[t].push(c);
  }

  for (const [type, items] of Object.entries(byType)) {
    const emoji = typeEmoji[type] || '📋';

    // Sub-heading per type
    blocks.push({
      object: 'block',
      type: 'heading_3',
      heading_3: {
        rich_text: [{ type: 'text', text: { content: `${emoji} ${type.toUpperCase()}` } }],
      },
    });

    for (const c of items) {
      const testableLabel = c.testable ? '✔ Testable' : '⚠ Needs refinement';
      const costLabel = `Est. cost: $${(c.estimated_cost || 0).toFixed(2)}`;
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [
            {
              type: 'text',
              text: { content: c.description || '' },
              annotations: { bold: false },
            },
            {
              type: 'text',
              text: { content: `  [${testableLabel} | ${costLabel}]` },
              annotations: { color: 'gray' },
            },
          ],
        },
      });
    }
  }

  return blocks;
}

// ── Escalation ──────────────────────────────────────────────────────────────

async function escalate(reason, context) {
  if (!AGENT_FORGE_URL || !AGENT_FORGE_API_SECRET) {
    console.error('Cannot escalate: missing AGENT_FORGE_URL or AGENT_FORGE_API_SECRET');
    return;
  }
  try {
    const res = await fetch(`${AGENT_FORGE_URL}/api/escalations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AGENT_FORGE_API_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workItemId: 'acceptance-criteria-agent',
        reason,
        confidenceScore: 0.2,
        contextSnapshot: context,
      }),
    });
    if (!res.ok) {
      console.error(`Escalation API returned ${res.status}`);
    } else {
      console.log('Escalation filed successfully');
    }
  } catch (err) {
    console.error('Failed to escalate:', err.message);
  }
}

// ── Page title helper ───────────────────────────────────────────────────────

function getPageTitle(page) {
  const titleProp = page.properties?.Name || page.properties?.Title;
  if (!titleProp) return page.id;
  if (titleProp.title) return richTextToPlain(titleProp.title) || page.id;
  return page.id;
}

// ── Per-page processing ─────────────────────────────────────────────────────

async function processDraftPRD(page) {
  const pageId = page.id;
  const title = getPageTitle(page);
  const status = page.properties?.Status?.select?.name || 'Draft';

  console.log(`\n📄 Processing: "${title}" [${status}]`);

  // Fetch blocks
  const blocks = await getPageBlocks(pageId);
  const alreadyHasCriteria = hasAcceptanceCriteriaSection(blocks);

  if (status === 'Draft' && !alreadyHasCriteria) {
    // ── First-time criteria generation ──
    console.log('  → No existing criteria. Generating...');
    const prdText = extractPRDText(blocks);

    if (!prdText.trim()) {
      console.log('  → PRD has no content yet. Skipping.');
      return;
    }

    let result;
    try {
      result = await generateAcceptanceCriteria(title, prdText);
    } catch (err) {
      console.error(`  → Claude error: ${err.message}`);
      await escalate(`Claude failed to generate criteria for PRD "${title}"`, {
        step: 'generate-criteria',
        error: err.message,
        filesChanged: ['.github/actions/acceptance-criteria-agent/index.js'],
      });
      return;
    }

    const { criteria, summary } = result;
    if (!criteria || criteria.length === 0) {
      console.log('  → Claude returned no criteria. Skipping.');
      return;
    }

    // Append criteria blocks
    const newBlocks = buildAcceptanceCriteriaBlocks(criteria, summary);
    await appendBlocks(pageId, newBlocks);

    // Update properties
    const totalCost = criteria.reduce((sum, c) => sum + (c.estimated_cost || 0), 0);
    await updatePageProperties(pageId, {
      Status: { select: { name: 'In Review' } },
      'Criteria Count': { number: criteria.length },
      'Estimated Cost': { number: Math.round(totalCost * 100) / 100 },
    });

    console.log(`  ✅ Generated ${criteria.length} criteria. Status → In Review.`);

  } else if (alreadyHasCriteria) {
    // ── Review loop: check comments ──
    console.log('  → Has existing criteria. Checking for unprocessed comments...');

    const comments = await getPageComments(pageId);
    if (!comments || comments.length === 0) {
      console.log('  → No comments found. Nothing to do.');
      return;
    }

    // Filter to comments that look like feedback (not agent-posted summaries)
    // Heuristic: skip comments that contain our summary marker text
    const feedbackComments = comments.filter(c => {
      const text = richTextToPlain(c.rich_text || []);
      return !text.startsWith('[Agent]') && text.trim().length > 0;
    });

    if (feedbackComments.length === 0) {
      console.log('  → No unprocessed PM feedback comments. Nothing to do.');
      return;
    }

    console.log(`  → Found ${feedbackComments.length} feedback comment(s). Revising criteria...`);

    // Extract existing criteria text for context
    const existingCriteriaText = extractPRDText(blocks);

    let result;
    try {
      result = await generateAcceptanceCriteria(title, existingCriteriaText, existingCriteriaText, feedbackComments);
    } catch (err) {
      console.error(`  → Claude error during revision: ${err.message}`);
      await escalate(`Claude failed to revise criteria for PRD "${title}"`, {
        step: 'revise-criteria',
        error: err.message,
        filesChanged: ['.github/actions/acceptance-criteria-agent/index.js'],
      });
      return;
    }

    const { criteria, summary } = result;
    if (!criteria || criteria.length === 0) {
      console.log('  → Claude returned no revised criteria. Skipping.');
      return;
    }

    // Remove old acceptance criteria section blocks (find the section and delete from heading down)
    // Strategy: delete all blocks from (and including) the AC heading to end of its section
    const acHeadingId = findAcceptanceCriteriaHeadingId(blocks);
    if (acHeadingId) {
      // Find index and delete from the divider before heading (if present) through end of AC section
      const headingIdx = blocks.findIndex(b => b.id === acHeadingId);
      // Delete from divider (if immediately before) + heading + all content until next h2 or end
      const toDelete = [];
      let i = headingIdx;
      // Check if preceding block is a divider
      if (headingIdx > 0 && blocks[headingIdx - 1].type === 'divider') {
        toDelete.push(blocks[headingIdx - 1].id);
      }
      // Delete heading and following blocks until next heading_2 or end
      while (i < blocks.length) {
        const b = blocks[i];
        if (i > headingIdx && b.type === 'heading_2') break;
        toDelete.push(b.id);
        i++;
      }

      for (const blockId of toDelete) {
        try {
          await deleteBlock(blockId);
        } catch (err) {
          console.warn(`  ⚠ Could not delete block ${blockId}: ${err.message}`);
        }
      }
    }

    // Append new criteria blocks
    const newBlocks = buildAcceptanceCriteriaBlocks(criteria, summary);
    await appendBlocks(pageId, newBlocks);

    // Update properties
    const totalCost = criteria.reduce((sum, c) => sum + (c.estimated_cost || 0), 0);
    const currentRounds = page.properties?.['Review Rounds']?.number || 0;

    await updatePageProperties(pageId, {
      'Criteria Count': { number: criteria.length },
      'Estimated Cost': { number: Math.round(totalCost * 100) / 100 },
      'Review Rounds': { number: currentRounds + 1 },
    });

    console.log(`  ✅ Revised criteria (${criteria.length} total). Review Rounds → ${currentRounds + 1}.`);

  } else {
    console.log('  → No action needed for this page state.');
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 Acceptance Criteria Agent starting...');
  console.log(`   Database: ${PRD_DATABASE_ID}`);
  console.log(`   Time: ${new Date().toISOString()}`);

  if (!ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY');
  if (!NOTION_API_KEY) throw new Error('Missing NOTION_API_KEY');

  let pages;
  try {
    pages = await queryPRDs();
  } catch (err) {
    console.error('Failed to query Notion database:', err.message);
    await escalate('Notion database query failed', {
      step: 'query-database',
      error: err.message,
      filesChanged: [],
    });
    process.exit(1);
  }

  console.log(`\nFound ${pages.length} Draft/In-Review PRD(s).`);

  let processed = 0;
  let skipped = 0;
  let errored = 0;

  for (const page of pages) {
    const status = page.properties?.Status?.select?.name;
    if (status === 'Approved') {
      console.log(`  ⏭ Skipping Approved page: ${getPageTitle(page)}`);
      skipped++;
      continue;
    }

    try {
      await processDraftPRD(page);
      processed++;
    } catch (err) {
      console.error(`  ❌ Error processing page ${page.id}: ${err.message}`);
      errored++;
      await escalate(`Unhandled error processing PRD "${getPageTitle(page)}"`, {
        step: 'process-prd',
        error: err.message,
        filesChanged: ['.github/actions/acceptance-criteria-agent/index.js'],
      });
    }

    // Brief delay to avoid Notion rate limits (3 req/s)
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`\n✅ Agent run complete.`);
  console.log(`   Processed: ${processed} | Skipped: ${skipped} | Errors: ${errored}`);
}

main().catch(async (err) => {
  console.error('Fatal error:', err.message);
  await escalate('Acceptance Criteria Agent fatal crash', {
    step: 'main',
    error: err.message,
    filesChanged: ['.github/actions/acceptance-criteria-agent/index.js'],
  });
  process.exit(1);
});
```

### Step 5: Verify file structure

```bash
find .github/actions/acceptance-criteria-agent -type f
find .github/workflows -name "acceptance-criteria-agent.yml"
```

Expected output:
```
.github/actions/acceptance-criteria-agent/action.yml
.github/actions/acceptance-criteria-agent/index.js
.github/actions/acceptance-criteria-agent/package.json
.github/workflows/acceptance-criteria-agent.yml
```

### Step 6: Validate YAML syntax

```bash
# Validate YAML files if python/npm tooling is available
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/acceptance-criteria-agent.yml'))" && echo "workflow YAML ok"
python3 -c "import yaml; yaml.safe_load(open('.github/actions/acceptance-criteria-agent/action.yml'))" && echo "action YAML ok"
```

### Step 7: Validate JS syntax

```bash
node --check .github/actions/acceptance-criteria-agent/index.js && echo "JS syntax ok"
```

### Step 8: Verify no TypeScript errors in repo

```bash
npx tsc --noEmit 2>&1 | head -20
```

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add Acceptance Criteria Agent for PRD validation

Adds a GitHub Actions-based TLM agent that reads PRDs from the Notion
'PRDs & Acceptance Criteria' database and generates structured, testable
acceptance criteria using Claude.

- Workflow: .github/workflows/acceptance-criteria-agent.yml (30-min cron + dispatch)
- Action: .github/actions/acceptance-criteria-agent/action.yml (composite)
- Logic: .github/actions/acceptance-criteria-agent/index.js (Notion API + Claude)

Features:
- Queries Notion DB 04216ec5-2206-4753-9063-d058f636cb46 for Draft PRDs
- Generates criteria with type, testability flag, and cost estimate
- Posts criteria back as structured Notion blocks
- Updates Status → In Review, sets Criteria Count and Estimated Cost
- Review loop: reads PM comments, revises criteria, tracks Review Rounds
- Skips Approved pages (criteria frozen)
- Escalates to Agent Forge on unrecoverable errors"

git push origin feat/acceptance-criteria-agent

gh pr create \
  --title "feat: Intent Validation Phase 1 — Acceptance Criteria Agent" \
  --body "## Summary

Implements the Acceptance Criteria Agent as a GitHub Actions TLM agent. The agent reads PRDs from the Notion 'PRDs & Acceptance Criteria' database, generates structured testable acceptance criteria using Claude, and posts them back to Notion.

## What's New

### Files Created
- \`.github/workflows/acceptance-criteria-agent.yml\` — 30-min cron + workflow_dispatch trigger
- \`.github/actions/acceptance-criteria-agent/action.yml\` — composite action with 4 inputs
- \`.github/actions/acceptance-criteria-agent/index.js\` — full agent logic
- \`.github/actions/acceptance-criteria-agent/package.json\` — @anthropic-ai/sdk dependency

### Agent Behavior
1. **First run on Draft PRD**: Reads content → Claude generates criteria → Appends Acceptance Criteria section → Status → In Review
2. **Subsequent runs (In Review)**: Reads Notion comments → Claude revises criteria → Replaces section → Increments Review Rounds
3. **Approved PRDs**: Skipped (criteria frozen)
4. **Errors**: Escalated to Agent Forge via \`/api/escalations\`

### Criteria Schema
Each criterion has: \`description\` (concrete/measurable), \`type\` (ui/api/data/integration/performance), \`testable\` (boolean), \`estimated_cost\` (USD)

## Required Secrets
Ensure these are set in the repo:
- \`ANTHROPIC_API_KEY\`
- \`NOTION_API_KEY\`
- \`AGENT_FORGE_URL\`
- \`AGENT_FORGE_API_SECRET\`

## Testing
After merge, trigger via Actions → Acceptance Criteria Agent → Run workflow. A PRD page with Status=Draft and body content in the Notion database will be processed.
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles/is syntactically valid
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/acceptance-criteria-agent
FILES CHANGED:
  - .github/workflows/acceptance-criteria-agent.yml
  - .github/actions/acceptance-criteria-agent/action.yml
  - .github/actions/acceptance-criteria-agent/index.js
  - .github/actions/acceptance-criteria-agent/package.json
SUMMARY: [what was completed]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "NOTION_API_KEY secret must be added to repo settings", "Notion database property names may differ from assumed — verify Status/Criteria Count/Review Rounds/Estimated Cost exist"]
```

## Important Notes for the Executing Agent

1. **Notion property names are assumed** — if the Notion database uses different property names (e.g., "review_rounds" instead of "Review Rounds"), the `updatePageProperties` calls will silently fail or error. If you can verify property names via a test Notion API call, do so.

2. **`@anthropic-ai/sdk` version** — use `^0.20.0` which is stable. If the action environment has network issues installing npm packages, consider pinning to a specific version.

3. **Claude model** — the index.js uses `claude-opus-4-5`. If this model ID is unavailable or deprecated, substitute `claude-opus-4` or `claude-3-5-sonnet-20241022`.

4. **Notion comment API** — the `GET /comments?block_id=<pageId>` endpoint requires the integration to have "Read comments" capability enabled in Notion's integration settings. If comments return empty unexpectedly, this is the likely cause.

5. **Block deletion for revision** — the delete-and-rewrite strategy for the AC section is aggressive. If Notion API returns errors on delete (e.g., blocks are referenced elsewhere), log and continue rather than aborting.