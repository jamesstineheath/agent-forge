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
- **Estimated files:** .github/workflows/acceptance-criteria-agent.yml, .github/actions/acceptance-criteria-agent/action.yml, .github/actions/acceptance-criteria-agent/index.js, .github/actions/acceptance-criteria-agent/package.json

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
4. Create `.github/actions/acceptance-criteria-agent/package.json` with `@anthropic-ai/sdk` dependency
5. Agent queries the Notion database `04216ec5-2206-4753-9063-d058f636cb46` for pages with Status = "Draft" or "In Review"
6. For each Draft PRD, agent reads page content blocks to extract the PRD body text
7. Agent skips PRDs that already have an "Acceptance Criteria" section (detected by searching for a heading block with that text)
8. Agent calls Claude to generate structured acceptance criteria from the PRD content
9. Each criterion must have: `description` (string), `type` (one of: `ui`, `api`, `data`, `integration`, `performance`), `testable` (boolean), `estimated_cost` (number in USD)
10. Criteria descriptions must be concrete and measurable (not vague); Claude prompt enforces this with examples
11. Agent appends a well-formatted "Acceptance Criteria" section to the PRD page using Notion block API
12. Agent updates page properties: Status → "In Review", Criteria Count → number of criteria, Estimated Cost → sum of estimated costs
13. On subsequent runs, for In-Review PRDs that already have acceptance criteria, agent reads Notion page comments and checks for unprocessed feedback (comments posted AFTER the agent's last `[Agent]` marker comment)
14. If unprocessed comments exist, Claude regenerates/adjusts criteria incorporating the feedback, updates the page content, increments Review Rounds, and posts a new `[Agent]` marker comment
15. Agent skips pages with Status = "Approved" (criteria frozen)
16. On unrecoverable errors, agent calls the Agent Forge escalation API
17. All Notion API calls use the official REST API (not an SDK) with `Authorization: Bearer ${NOTION_API_KEY}` and `Notion-Version: 2022-06-28` headers

## Execution Steps

### Step 0: Branch setup