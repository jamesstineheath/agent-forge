# Agent Forge -- A5: Plan Validator Module

## Metadata
- **Branch:** `feat/a5-plan-validator-module`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/plan-validator.ts, lib/types.ts

## Context

Agent Forge is a dev orchestration platform (Next.js on Vercel) that coordinates autonomous agent teams. The Decomposer reads Notion project plan pages and generates ordered work items. Before decomposition runs, we need a validation step (`validatePlan`) that inspects the plan page for required structure and quality, so the decomposer doesn't operate on malformed or incomplete plans.

This is module A5 in the PM Agent feature series. Related completed modules include:
- A2: `lib/pm-prompts.ts` — PM Agent Prompts Library
- A3: `lib/pm-agent.ts` — Core PM Agent module
- A4: `app/api/pm-agent/route.ts` — PM Agent API routes
- A7: ATC Section 14 PM Agent sweep

Key existing files:
- `lib/notion.ts` — exports `fetchPageContent(pageId: string): Promise<string>` (fetches Notion page content as text)
- `lib/repos.ts` — exports a repos registry / functions to look up registered repos
- `lib/types.ts` — shared types; `PlanValidation` and `PlanValidationIssue` must be added here

## Requirements

1. Add `PlanValidationIssue` and `PlanValidation` types to `lib/types.ts`
2. Create `lib/plan-validator.ts` exporting `validatePlan(projectId: string): Promise<PlanValidation>`
3. `validatePlan` fetches plan page content via `fetchPageContent` from `lib/notion.ts`
4. If content is empty/null, return a `PlanValidation` with `valid: false` and a single error issue indicating the plan page could not be fetched
5. Check for 4 required sections (case-insensitive heading match against H1/H2/H3 patterns): `Overview`, `Components` (also accept `Components / Changes`), `Sequencing Constraints`, `Acceptance Criteria` — missing sections produce `error` severity issues
6. Check acceptance criteria section: fewer than 3 criteria → `warning` severity issue
7. Individual acceptance criteria that are fewer than 10 words OR contain vague phrases (`works correctly`, `is good`, `functions properly`) → `warning` severity issue per criterion
8. If a target repo is mentioned in content but not found in the repos registry → `warning` severity issue
9. `valid` is `true` only when there are zero `error` severity issues
10. Project builds successfully with `npm run build` and `npx tsc --noEmit`

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/a5-plan-validator-module
```

### Step 1: Inspect existing types and repos exports

Before writing code, read the existing files to understand what's already exported:

```bash
cat lib/types.ts
cat lib/notion.ts
cat lib/repos.ts
```

Note:
- The exact signature of `fetchPageContent` in `lib/notion.ts` — it likely takes a `pageId`. The work item description says `validatePlan(projectId: string)`, so you'll need to figure out how to get the plan page ID from the project ID. Check `lib/notion.ts` and `lib/decomposer.ts` for the pattern used.
- The repos registry API in `lib/repos.ts` — look for a function like `getRegisteredRepos()`, `listRepos()`, or a direct export of repo data.

```bash
cat lib/decomposer.ts
```

### Step 2: Add types to `lib/types.ts`

Add the following type definitions to `lib/types.ts`. Insert them near other domain types (not at the very top with imports):

```typescript
// Plan Validator types
export interface PlanValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  section?: string; // optional: which section the issue relates to
}

export interface PlanValidation {
  valid: boolean;
  issues: PlanValidationIssue[];
  projectId: string;
  checkedAt: string; // ISO timestamp
}
```

### Step 3: Create `lib/plan-validator.ts`

Create the file with the following implementation. Read the existing notion/repos/decomposer code first to get the exact import paths and function signatures correct.

```typescript
import { PlanValidation, PlanValidationIssue } from './types';
import { fetchPageContent } from './notion';
import { getRegisteredRepos } from './repos'; // adjust function name after inspecting lib/repos.ts

const REQUIRED_SECTIONS = [
  'Overview',
  'Components',           // also matched by 'Components / Changes' etc.
  'Sequencing Constraints',
  'Acceptance Criteria',
] as const;

const VAGUE_PHRASES = [
  'works correctly',
  'is good',
  'functions properly',
];

/**
 * Checks whether the plan content contains a given section heading (H1, H2, or H3).
 * Match is case-insensitive. For 'Components', also accepts headings that start with 'Components'.
 */
function hasSection(content: string, section: string): boolean {
  // Match markdown headings: # Heading, ## Heading, ### Heading
  const headingPattern = /^#{1,3}\s+(.+)$/gm;
  const matches = [...content.matchAll(headingPattern)].map(m => m[1].trim());

  return matches.some(heading => {
    const h = heading.toLowerCase();
    const s = section.toLowerCase();
    if (s === 'components') {
      // Accept 'Components' or 'Components / Changes' or 'Components/Changes'
      return h === 'components' || h.startsWith('components');
    }
    return h === s;
  });
}

/**
 * Extracts lines from the Acceptance Criteria section until the next heading.
 */
function extractAcceptanceCriteria(content: string): string[] {
  const lines = content.split('\n');
  let inSection = false;
  const criteria: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      const heading = headingMatch[1].trim().toLowerCase();
      if (heading === 'acceptance criteria') {
        inSection = true;
        continue;
      } else if (inSection) {
        // Hit the next heading — stop
        break;
      }
    }
    if (inSection) {
      // Collect non-empty lines that look like list items or plain text
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        // Strip leading list markers (-, *, numbers)
        const criterion = trimmed.replace(/^[-*\d+.]\s*/, '').trim();
        if (criterion.length > 0) {
          criteria.push(criterion);
        }
      }
    }
  }

  return criteria;
}

/**
 * Count words in a string.
 */
function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Check if a criterion contains vague phrases.
 */
function isVague(criterion: string): boolean {
  const lower = criterion.toLowerCase();
  return VAGUE_PHRASES.some(phrase => lower.includes(phrase));
}

/**
 * Extract repo-like references from content (e.g., "owner/repo" patterns).
 */
function extractRepoReferences(content: string): string[] {
  // Match patterns like "jamesstineheath/some-repo" or "owner/repo-name"
  const repoPattern = /\b([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)\b/g;
  const matches = [...content.matchAll(repoPattern)];
  // Filter out things that look like file paths or URLs
  return [...new Set(
    matches
      .map(m => m[1])
      .filter(ref => !ref.includes('.') || ref.includes('/'))
      .filter(ref => /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(ref))
  )];
}

export async function validatePlan(projectId: string): Promise<PlanValidation> {
  const issues: PlanValidationIssue[] = [];
  const checkedAt = new Date().toISOString();

  // Fetch plan page content
  let content: string;
  try {
    content = await fetchPageContent(projectId);
  } catch (err) {
    return {
      valid: false,
      issues: [{
        severity: 'error',
        message: `Failed to fetch plan page content: ${err instanceof Error ? err.message : String(err)}`,
      }],
      projectId,
      checkedAt,
    };
  }

  if (!content || content.trim().length === 0) {
    return {
      valid: false,
      issues: [{
        severity: 'error',
        message: 'Plan page content is empty or could not be fetched.',
      }],
      projectId,
      checkedAt,
    };
  }

  // 1. Check required sections
  for (const section of REQUIRED_SECTIONS) {
    if (!hasSection(content, section)) {
      issues.push({
        severity: 'error',
        message: `Required section "${section}" is missing from the plan.`,
        section,
      });
    }
  }

  // 2. Validate acceptance criteria
  const criteria = extractAcceptanceCriteria(content);

  if (criteria.length < 3) {
    issues.push({
      severity: 'warning',
      message: `Acceptance Criteria section contains ${criteria.length} criterion/criteria; at least 3 are recommended.`,
      section: 'Acceptance Criteria',
    });
  }

  for (const criterion of criteria) {
    if (wordCount(criterion) < 10) {
      issues.push({
        severity: 'warning',
        message: `Acceptance criterion is too short (fewer than 10 words): "${criterion}"`,
        section: 'Acceptance Criteria',
      });
    } else if (isVague(criterion)) {
      issues.push({
        severity: 'warning',
        message: `Acceptance criterion contains vague language: "${criterion}"`,
        section: 'Acceptance Criteria',
      });
    }
  }

  // 3. Check repo references
  try {
    const registeredRepos = await getRegisteredRepos(); // adjust based on lib/repos.ts API
    const repoFullNames = registeredRepos.map((r: { fullName?: string; name?: string; repo?: string }) =>
      r.fullName ?? r.name ?? r.repo ?? ''
    ).filter(Boolean);

    const referencedRepos = extractRepoReferences(content);
    for (const ref of referencedRepos) {
      if (!repoFullNames.some((name: string) => name.toLowerCase() === ref.toLowerCase())) {
        issues.push({
          severity: 'warning',
          message: `Referenced repo "${ref}" is not found in the repos registry.`,
        });
      }
    }
  } catch {
    // Non-fatal: if we can't load repos, skip this check
    issues.push({
      severity: 'warning',
      message: 'Could not load repos registry to validate repo references.',
    });
  }

  const valid = !issues.some(i => i.severity === 'error');

  return {
    valid,
    issues,
    projectId,
    checkedAt,
  };
}
```

**Important:** After reading `lib/repos.ts`, adjust the import and usage of `getRegisteredRepos()` to match what's actually exported. Common patterns seen in this codebase:
- `getRegisteredRepos()` returning `Promise<Repo[]>`
- `listRepos()` returning repo objects from Vercel Blob
- Direct `repos` array exports

Also check the signature of `fetchPageContent` in `lib/notion.ts`. If it takes a `pageId` parameter and `projectId` is a Notion project record ID (not a page ID), check `lib/decomposer.ts` to see how it maps project → plan page ID. You may need to use `fetchPageContent(projectId)` directly if the project ID is itself the Notion page ID, or fetch the project record first.

### Step 4: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues to watch for:
- `fetchPageContent` return type might be `string | null` — handle null explicitly
- Repos registry type might need adjustment
- `PlanValidationIssue.section` is optional — make sure usages are consistent

### Step 5: Build check

```bash
npm run build
```

Fix any build errors. The new file should not affect existing functionality since it only adds new exports.

### Step 6: Smoke test (optional manual verification)

If you want to quickly verify the logic works without a full integration test:

```bash
node -e "
const { validatePlan } = require('./lib/plan-validator');
// This will fail to fetch (expected in local dev), but should return a structured error
validatePlan('test-project-id').then(r => console.log(JSON.stringify(r, null, 2))).catch(console.error);
"
```

Or create a quick unit test inline to verify the section-detection logic:

```bash
node -e "
// Inline test of section detection logic
const content = \`
# Overview
Some overview text.

## Components / Changes
- Component A

## Sequencing Constraints
Do this first.

## Acceptance Criteria
- The system processes requests within 200ms under normal load conditions
- All API endpoints return structured error responses with HTTP status codes
- The dashboard displays real-time updates without requiring manual page refresh
\`;

// Manually test section regex
const headingPattern = /^#{1,3}\s+(.+)$/gm;
const headings = [...content.matchAll(headingPattern)].map(m => m[1].trim());
console.log('Found headings:', headings);
"
```

### Step 7: Verification

```bash
npx tsc --noEmit
npm run build
```

Both must pass with zero errors.

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: A5 plan validator module with required section and criteria checks"
git push origin feat/a5-plan-validator-module
gh pr create \
  --title "feat: A5 Plan Validator Module" \
  --body "## Summary

Adds \`lib/plan-validator.ts\` — a new module that validates Notion plan pages before decomposition.

## Changes

- **\`lib/types.ts\`**: Added \`PlanValidationIssue\` and \`PlanValidation\` types
- **\`lib/plan-validator.ts\`**: New module exporting \`validatePlan(projectId)\`

## Validation Rules

- **Error**: Missing required section (Overview, Components, Sequencing Constraints, Acceptance Criteria)
- **Error**: Plan page content empty or unfetchable
- **Warning**: Fewer than 3 acceptance criteria
- **Warning**: Individual criterion is vague (contains 'works correctly', 'is good', 'functions properly') or fewer than 10 words
- **Warning**: Referenced repo not found in repos registry

## Acceptance Criteria

- [x] \`lib/plan-validator.ts\` exists and exports \`validatePlan(projectId: string): Promise<PlanValidation>\`
- [x] Missing required sections produce error-severity issues
- [x] Vague/short acceptance criteria produce warning-severity issues
- [x] \`valid\` is true only when zero error-severity issues exist
- [x] Build passes (\`npm run build\`, \`npx tsc --noEmit\`)
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/a5-plan-validator-module
FILES CHANGED: [lib/types.ts, lib/plan-validator.ts]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you encounter a blocker that cannot be resolved autonomously (e.g., `fetchPageContent` has a completely different signature than expected, `lib/repos.ts` doesn't export any list/get function, or there are architectural conflicts with existing types), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "a5-plan-validator-module",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/types.ts", "lib/plan-validator.ts"]
    }
  }'
```