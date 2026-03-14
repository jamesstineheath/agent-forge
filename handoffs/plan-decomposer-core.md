# Agent Forge -- Plan Decomposer Core

## Metadata
- **Branch:** `feat/plan-decomposer-core`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $8
- **Risk Level:** medium
- **Estimated files:** lib/decomposer.ts, lib/notion.ts, lib/types.ts, scripts/test-decomposer.ts

## Context

Agent Forge's pipeline can autonomously execute handoffs end-to-end: Spec Review improves the handoff, Execute Handoff runs Claude Code, Code Review gates the PR, and ATC manages concurrency. But the step between "architecture plan exists in Notion" and "work items exist in the Work Item Store" still requires a human generating each handoff manually.

Phase 2e-3 adds the Plan Decomposer: an agent that reads a Notion project's architecture spec and decomposes it into an ordered sequence of work items that the existing pipeline can execute. This handoff implements the core decomposer agent and the Notion page content fetcher it depends on.

The decomposer outputs work item descriptions (not full handoff markdown). The existing Orchestrator's `generateHandoff` function expands descriptions into v3 handoff files at dispatch time with fresh repo context. This separation of concerns means the decomposer focuses on strategic decomposition (what to build, in what order, at what risk level) while the Orchestrator handles tactical handoff generation.

### Existing patterns to follow

**Work item creation** uses `createWorkItem` from `lib/work-items.ts`. It accepts a `CreateWorkItemInput` with title, description, targetRepo, source, priority, riskLevel, complexity, and dependencies.

**Source types** are currently `"pa-improvement" | "github-issue" | "manual"` in `lib/types.ts`. This handoff adds `"project"`.

**Notion client** exists in `lib/notion.ts` with `queryProjects` and `updateProjectStatus`. Uses `@notionhq/client`. The client is initialized lazily via `getClient()`.

**Repo context fetching** uses `fetchRepoContext` from `lib/orchestrator.ts`, which returns `{ claudeMd, systemMap, adrs, recentPRs }`.

**Claude calls** use `generateText` from the `ai` SDK with `anthropic("claude-opus-4-6")` or `anthropic("claude-sonnet-4-6")`.

**Escalation** uses `escalate()` from `lib/escalation.ts` with `workItemId`, `reason`, `confidenceScore`, and `contextSnapshot`.

## Requirements

1. Add `"project"` to the source type union in `lib/types.ts` (both the interface and the zod schemas: `createWorkItemSchema` and `updateWorkItemSchema`).
2. Add `fetchPageContent(pageId: string): Promise<string>` to `lib/notion.ts` that retrieves a Notion page's block children and converts them to a markdown string. Must handle: headings (h1-h3), paragraphs, bulleted lists, numbered lists, code blocks, toggle blocks (read the children), and callout blocks. Use the Notion SDK's `blocks.children.list` endpoint. Paginate if `has_more` is true. Return a single markdown string.
3. Create `lib/decomposer.ts` with the main function `decomposeProject(project: Project): Promise<WorkItem[]>`. The function should:
   a. Read the Notion plan page content via `fetchPageContent` (extract page ID from `project.planUrl`).
   b. Determine target repo(s): use `project.targetRepo` as the primary, but parse the plan content for mentions of other repos (e.g., "personal-assistant", "rez-sniper", "agent-forge").
   c. Fetch repo context for each target repo using `fetchRepoContext` from `lib/orchestrator.ts`.
   d. Call Claude Opus with a structured decomposition prompt (see Decomposition Prompt section below).
   e. Parse the JSON array output into work item specs.
   f. Create work items via `createWorkItem` with `source.type: "project"` and `source.sourceId: project.projectId`.
   g. Set all created items to `status: "ready"` via `updateWorkItem`.
   h. Return the created work items.
4. The decomposition prompt must instruct Claude to produce a JSON array where each element has: `title`, `description`, `targetRepo`, `priority`, `riskLevel`, `complexity`, `dependencies` (array of indices into the same array, 0-indexed), and `acceptanceCriteria` (array of 3-5 specific, testable strings).
5. The decomposer must validate Claude's output: check JSON parses, check required fields exist, check dependency indices are valid (no self-references, no indices out of bounds, no circular dependencies). If validation fails, retry once with the error message appended. If it fails twice, escalate.
6. The decomposer must escalate (via `escalate()`) when: the plan page is empty or lacks an identifiable problem statement, the plan references repos not registered in Agent Forge, or the decomposition would produce more than 15 work items (suggesting the plan should be split).
7. Create `scripts/test-decomposer.ts` that: creates a mock project record pointing to a real Notion page, calls `decomposeProject`, and validates the output structure (correct fields, valid dependency graph, acceptance criteria present). Use `console.log` for output, `process.exit(1)` on failure.
8. The `description` field on each generated work item must be rich enough for `generateHandoff` to produce a good v3 file. Include: what to implement, which files to create/modify, key implementation details (function signatures, data structures), and the acceptance criteria.
9. Embed the acceptance criteria directly in the work item description (under a `## Acceptance Criteria` heading) so they flow through to the generated handoff and can be verified by the executing agent.

## Decomposition Prompt Design

The system prompt for the decomposer should include:

```
You are a Plan Decomposer for an autonomous dev pipeline. Your job is to read an architecture
specification and break it into a sequence of small, independently executable work items.

Each work item will be expanded into a handoff file and executed by an AI coding agent (Claude Code)
in a GitHub Actions environment. The agent has no context beyond the handoff file and the target
repo's CLAUDE.md / system map.

CONSTRAINTS:
- Each work item should touch 1-3 files maximum
- Each work item must compile and pass tests independently after execution
- Each work item must have 3-5 specific, testable acceptance criteria
- Dependencies must form a DAG (no cycles)
- Prefer more, smaller items over fewer, larger ones
- The first item in the sequence should be the lowest-risk foundational change
- Include a final integration/E2E test item that depends on all others

OUTPUT FORMAT:
Return a JSON array (no markdown fencing, no explanation) where each element is:
{
  "title": "Short descriptive title",
  "description": "Rich description including: what to implement, files to create/modify, key implementation details (function signatures, data structures), and acceptance criteria",
  "targetRepo": "owner/repo-name",
  "priority": "high|medium|low",
  "riskLevel": "low|medium|high",
  "complexity": "simple|moderate|complex",
  "dependencies": [0, 1],  // indices of items this depends on (0-indexed)
  "acceptanceCriteria": [
    "Specific testable criterion 1",
    "Specific testable criterion 2"
  ]
}
```

The user prompt should include: the plan page content, repo context (CLAUDE.md, system map, ADRs, recent PRs) for each target repo, and the project metadata (priority, complexity, risk level).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/plan-decomposer-core
```

### Step 1: Add "project" source type to lib/types.ts

In the `WorkItem` interface, change the source type union:
```typescript
source: {
  type: "pa-improvement" | "github-issue" | "manual" | "project";
  sourceId?: string;
  sourceUrl?: string;
};
```

Update `createWorkItemSchema` and `updateWorkItemSchema` similarly:
```typescript
type: z.enum(["pa-improvement", "github-issue", "manual", "project"]),
```

### Step 2: Add fetchPageContent to lib/notion.ts

Add a function that uses the Notion SDK to retrieve block children of a page and convert them to markdown. Handle pagination (the blocks API returns max 100 blocks per call). Convert block types: `heading_1/2/3`, `paragraph`, `bulleted_list_item`, `numbered_list_item`, `code`, `toggle`, `callout`, `divider`, `quote`. For rich text arrays, concatenate the `plain_text` values. For toggle blocks, recursively fetch children.

Export the function so `lib/decomposer.ts` can import it.

### Step 3: Create lib/decomposer.ts

Implement `decomposeProject` following the requirements above. Key implementation details:

- Extract page ID from `project.planUrl`. Handle both formats: `https://www.notion.so/Page-Title-<id>` and raw UUIDs. The page ID is the last 32 hex characters of the URL path (strip hyphens).
- Use `listRepos` from `lib/repos.ts` to validate that referenced repos are registered.
- Use `fetchRepoContext` from `lib/orchestrator.ts` for each target repo.
- Call `generateText` with `anthropic("claude-opus-4-6")` for the decomposition (this is a high-judgment task).
- Parse the response: strip any markdown code fences if present, then `JSON.parse`.
- Validate the parsed output (see requirement 5).
- Convert dependency indices to work item IDs: create items in order, map index to created item ID, then update each item's `dependencies` array with the actual IDs.
- After creating all items as `"filed"`, update each to `"ready"` status.

### Step 4: Create scripts/test-decomposer.ts

Write a test script that:
1. Imports `decomposeProject` from `../lib/decomposer`
2. Creates a Project object with `planUrl` pointing to a known Notion page (use the Phase 2e spec page as a test: `323041760b70813aa3f6e609a47cff57`)
3. Calls `decomposeProject` and checks the output
4. Validates: items array is non-empty, each item has required fields, dependency indices are valid, acceptance criteria arrays have 3-5 items
5. Logs results and exits with appropriate code

Add `scripts/` to the `exclude` array in `tsconfig.json` if not already present (it was added in H13).

### Step 5: Verification
```bash
npx tsc --noEmit
npm run build
```

Run the test script manually (requires NOTION_API_KEY, ANTHROPIC_API_KEY, and GH_PAT env vars):
```bash
npx tsx scripts/test-decomposer.ts
```

### Step 6: Commit, push, open PR
```bash
git add lib/decomposer.ts lib/notion.ts lib/types.ts scripts/test-decomposer.ts
git commit -m "feat: add Plan Decomposer core (2e-3 H14)

- Add 'project' source type to WorkItem
- Add fetchPageContent to Notion client for reading plan pages
- Create decomposer agent: reads Notion plan, produces ordered work items
- Structured Claude Opus prompt for plan decomposition
- Output validation with retry and escalation fallback
- Test script for decomposer verification"
git push origin feat/plan-decomposer-core
gh pr create --title "feat: Plan Decomposer core (Phase 2e-3, H14)" --body "## Summary
Adds the Plan Decomposer agent that reads a Notion architecture spec and decomposes it into ordered work items for the pipeline.

## Changes
- `lib/types.ts`: Add 'project' source type
- `lib/notion.ts`: Add fetchPageContent() for reading Notion page blocks as markdown
- `lib/decomposer.ts`: Core decomposer agent with Claude Opus, output validation, escalation
- `scripts/test-decomposer.ts`: Verification script

## Testing
- TypeScript compiles cleanly
- Build succeeds
- Test script validates decomposition output structure

Phase 2e-3 Handoff 14. Independent of H15."
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/plan-decomposer-core
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```
