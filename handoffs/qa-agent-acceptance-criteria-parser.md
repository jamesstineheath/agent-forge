# Agent Forge -- QA Agent Acceptance Criteria Parser

## Metadata
- **Branch:** `feat/qa-agent-acceptance-criteria-parser`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** .github/actions/tlm-qa-agent/src/parse-criteria.ts

## Context

Agent Forge has a TLM QA Agent that was recently scaffolded (see recent PRs). The QA agent needs to be able to parse acceptance criteria from PR descriptions written in handoff v3 format so it knows what to verify.

Handoff v3 format PR descriptions contain an `## Acceptance Criteria` section with bullet points. This module is a pure TypeScript utility — no external API calls, no file I/O — that takes a PR description string and returns structured, typed criteria with classification hints for downstream automation.

The existing QA agent action lives at `.github/actions/tlm-qa-agent/`. The new file goes in a `src/` subdirectory as part of the action's TypeScript source.

## Requirements

1. Create `.github/actions/tlm-qa-agent/src/parse-criteria.ts` with the exact exports described below
2. Export `ParsedCriterion` interface: `{ criterion: string; category: 'http' | 'playwright' | 'not-verifiable' }`
3. Export `parseAcceptanceCriteria(prDescription: string): ParsedCriterion[]` function
4. Parser finds acceptance criteria section using case-insensitive match on `## Acceptance Criteria`, `### Acceptance Criteria`, or any heading/line containing "acceptance criteria"
5. Extract individual criteria from `-`, `*`, or numbered list (`1.`, `2.`, etc.) bullet points within that section
6. Stop extracting when a new `##` heading is encountered (section boundary)
7. Classify each criterion:
   - `'http'`: criterion mentions API routes (`/api/`, route paths), HTTP status codes (`200`, `404`, `4xx`, `5xx`), response formats (`JSON`, `payload`, `returns`), REST verbs (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`), or `endpoint`
   - `'playwright'`: criterion mentions UI elements (`button`, `page`, `modal`, `form`, `click`, `navigate`, `display`, `visible`, `render`, `user`, `browser`, `redirect`), or visual/interaction state
   - `'not-verifiable'`: criterion mentions cron, schedule, env var, environment variable, background process, secret, or is too vague (fewer than 5 words after stripping bullets)
8. When no acceptance criteria section is found, return `[]` (not an error/throw)
9. Also export `extractHandoffTitle(prDescription: string): string | null` — extracts the first `# Title` heading from the PR description
10. Also export `extractFilePaths(prDescription: string): string[]` — extracts file paths (strings matching patterns like `path/to/file.ts`, `` `path/file` ``, or lines starting with `-` containing `.ts`, `.tsx`, `.yml`, `.json`, `.md` that look like paths)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/qa-agent-acceptance-criteria-parser
```

### Step 1: Create the src directory and parse-criteria.ts

Create `.github/actions/tlm-qa-agent/src/parse-criteria.ts` with the following implementation:

```typescript
/**
 * parse-criteria.ts
 *
 * Pure utility to parse acceptance criteria from handoff v3 format PR descriptions.
 * No external dependencies — operates entirely on string input.
 */

export interface ParsedCriterion {
  criterion: string;
  category: 'http' | 'playwright' | 'not-verifiable';
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

const HTTP_PATTERNS = [
  /\/api\//i,
  /\bhttp\s*status\b/i,
  /\b[245]\d{2}\b/,           // status codes like 200, 404, 500
  /\b(4|5)xx\b/i,
  /\bjson\b/i,
  /\bpayload\b/i,
  /\bresponse\b/i,
  /\bendpoint\b/i,
  /\b(GET|POST|PUT|DELETE|PATCH)\b/,
  /\brest\b/i,
  /\broute\b/i,
  /\breturns?\b/i,
];

const PLAYWRIGHT_PATTERNS = [
  /\bbutton\b/i,
  /\bpage\b/i,
  /\bmodal\b/i,
  /\bform\b/i,
  /\bclick\b/i,
  /\bnavigate\b/i,
  /\bdisplay\b/i,
  /\bvisible\b/i,
  /\brender\b/i,
  /\buser\b/i,
  /\bbrowser\b/i,
  /\bredirect\b/i,
  /\bui\b/i,
  /\bcomponent\b/i,
  /\btext\b/i,
  /\blink\b/i,
  /\bmenu\b/i,
  /\btab\b/i,
  /\bscroll\b/i,
  /\binteract\b/i,
];

const NOT_VERIFIABLE_PATTERNS = [
  /\bcron\b/i,
  /\bschedul/i,
  /\benv(ironment)?\s*(var(iable)?)?/i,
  /\bsecret\b/i,
  /\bbackground\s*process\b/i,
  /\bbackground\s*job\b/i,
  /\bdaemon\b/i,
  /\bwebhook\b/i,
];

function classifyCriterion(criterion: string): 'http' | 'playwright' | 'not-verifiable' {
  // Strip bullet/numbering prefix for word-count check
  const text = criterion.replace(/^[-*\d.)\s]+/, '').trim();

  // Too vague: fewer than 5 words
  if (text.split(/\s+/).filter(Boolean).length < 5) {
    return 'not-verifiable';
  }

  // Check not-verifiable first (strongest signal)
  for (const pattern of NOT_VERIFIABLE_PATTERNS) {
    if (pattern.test(criterion)) return 'not-verifiable';
  }

  // Check http
  for (const pattern of HTTP_PATTERNS) {
    if (pattern.test(criterion)) return 'http';
  }

  // Check playwright
  for (const pattern of PLAYWRIGHT_PATTERNS) {
    if (pattern.test(criterion)) return 'playwright';
  }

  // Default: not-verifiable (too ambiguous to automate)
  return 'not-verifiable';
}

// ---------------------------------------------------------------------------
// Section extraction
// ---------------------------------------------------------------------------

/**
 * Find the acceptance criteria section in a PR description and return
 * the lines belonging to that section (up to the next ## heading).
 */
function extractAcceptanceCriteriaLines(prDescription: string): string[] {
  const lines = prDescription.split('\n');

  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    // Detect start of acceptance criteria section
    if (!inSection) {
      if (/^#{1,6}\s*acceptance\s+criteria\s*$/i.test(line.trim())) {
        inSection = true;
        continue;
      }
      continue;
    }

    // Detect end of section: any new ## (or higher) heading
    if (/^#{2,}\s+/.test(line)) {
      break;
    }

    sectionLines.push(line);
  }

  return sectionLines;
}

/**
 * Extract bullet/numbered list items from a set of lines.
 */
function extractBulletItems(lines: string[]): string[] {
  const items: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Match: - item, * item, 1. item, 1) item
    const match = trimmed.match(/^(?:[-*]|\d+[.):])\s+(.+)$/);
    if (match) {
      items.push(match[1].trim());
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse acceptance criteria from a handoff v3 format PR description.
 *
 * @param prDescription - Full PR description text
 * @returns Array of parsed criteria with classification, or [] if no section found
 */
export function parseAcceptanceCriteria(prDescription: string): ParsedCriterion[] {
  if (!prDescription || typeof prDescription !== 'string') return [];

  const sectionLines = extractAcceptanceCriteriaLines(prDescription);
  if (sectionLines.length === 0) return [];

  const bulletItems = extractBulletItems(sectionLines);
  if (bulletItems.length === 0) return [];

  return bulletItems.map((criterion) => ({
    criterion,
    category: classifyCriterion(criterion),
  }));
}

/**
 * Extract the handoff title from the first # heading in a PR description.
 *
 * @param prDescription - Full PR description text
 * @returns Title string, or null if not found
 */
export function extractHandoffTitle(prDescription: string): string | null {
  if (!prDescription) return null;

  for (const line of prDescription.split('\n')) {
    const match = line.trim().match(/^#\s+(.+)$/);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Extract file paths mentioned in a PR description.
 * Looks for:
 *  - Backtick-quoted paths containing a '/'
 *  - Bullet point lines that look like file paths (contain extension + slash)
 *  - Bare tokens that look like relative paths
 *
 * @param prDescription - Full PR description text
 * @returns Deduplicated array of file path strings
 */
export function extractFilePaths(prDescription: string): string[] {
  if (!prDescription) return [];

  const paths = new Set<string>();

  // Pattern 1: backtick-quoted paths e.g. `path/to/file.ts`
  const backtickPattern = /`([^`]*\/[^`]*\.[a-zA-Z]{1,6})`/g;
  let match: RegExpExecArray | null;
  while ((match = backtickPattern.exec(prDescription)) !== null) {
    paths.add(match[1].trim());
  }

  // Pattern 2: bullet list items that look like file paths
  // e.g. "- path/to/file.ts" or "- `path/to/file.ts`"
  const FILE_EXTENSIONS = /\.(ts|tsx|js|jsx|yml|yaml|json|md|css|html|sh)$/i;
  for (const line of prDescription.split('\n')) {
    const trimmed = line.trim();
    // Bullet line
    const bulletMatch = trimmed.match(/^[-*]\s+`?([^\s`]+)`?\s*$/);
    if (bulletMatch) {
      const candidate = bulletMatch[1].replace(/`/g, '').trim();
      if (FILE_EXTENSIONS.test(candidate) && candidate.includes('/')) {
        paths.add(candidate);
      }
    }
  }

  // Pattern 3: bare path-like tokens anywhere in text (e.g. lib/atc.ts, .github/actions/foo/bar.yml)
  const barePathPattern = /(?:^|\s)(\.?[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+\.[a-zA-Z]{1,6})(?:\s|$|[,;)])/gm;
  while ((match = barePathPattern.exec(prDescription)) !== null) {
    const candidate = match[1].trim();
    if (FILE_EXTENSIONS.test(candidate)) {
      paths.add(candidate);
    }
  }

  return Array.from(paths);
}
```

### Step 2: Verify the file compiles

Check if there's an existing `tsconfig.json` in the action directory:

```bash
ls .github/actions/tlm-qa-agent/
cat .github/actions/tlm-qa-agent/action.yml 2>/dev/null || echo "no action.yml"
```

If a `tsconfig.json` exists under `.github/actions/tlm-qa-agent/`, ensure it includes `src/`:

```bash
cat .github/actions/tlm-qa-agent/tsconfig.json 2>/dev/null || echo "no tsconfig"
```

If there is a `tsconfig.json` that needs updating to include `src/`, add `"include": ["src/**/*", "*.ts"]` (or ensure `src` isn't excluded). If no tsconfig exists at the action level, the file still needs to compile — check if there's a root-level `tsconfig.json`:

```bash
cat tsconfig.json
```

Attempt TypeScript type-check from repo root:
```bash
npx tsc --noEmit --strict .github/actions/tlm-qa-agent/src/parse-criteria.ts 2>&1 || true
```

If the root `tsconfig.json` doesn't pick up the file, check compilation manually:
```bash
npx tsc --noEmit --strict --target ES2020 --module commonjs --moduleResolution node .github/actions/tlm-qa-agent/src/parse-criteria.ts
```

Fix any type errors that appear (likely none given the implementation uses only built-in types).

### Step 3: Run project-level type check

```bash
npx tsc --noEmit
```

Resolve any errors introduced. The new file should not affect existing compilation since it introduces only new exports.

### Step 4: Verification

```bash
# Confirm file exists
ls -la .github/actions/tlm-qa-agent/src/parse-criteria.ts

# Confirm exports are present
grep -E "export (interface|function)" .github/actions/tlm-qa-agent/src/parse-criteria.ts

# Confirm expected exports
grep "parseAcceptanceCriteria" .github/actions/tlm-qa-agent/src/parse-criteria.ts
grep "extractHandoffTitle" .github/actions/tlm-qa-agent/src/parse-criteria.ts
grep "extractFilePaths" .github/actions/tlm-qa-agent/src/parse-criteria.ts
grep "ParsedCriterion" .github/actions/tlm-qa-agent/src/parse-criteria.ts

# Full type-check
npx tsc --noEmit
```

### Step 5: Build (if applicable)

```bash
npm run build 2>/dev/null || echo "no build step / build skipped"
```

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add QA agent acceptance criteria parser module"
git push origin feat/qa-agent-acceptance-criteria-parser
gh pr create \
  --title "feat: QA agent acceptance criteria parser" \
  --body "## Summary

Adds \`.github/actions/tlm-qa-agent/src/parse-criteria.ts\` — a pure TypeScript utility that parses acceptance criteria from handoff v3 format PR descriptions.

## What this does

- Finds the \`## Acceptance Criteria\` section in a PR description (case-insensitive, supports \`#\` through \`######\` headings)
- Extracts individual bullet/numbered criteria from that section
- Classifies each criterion as \`http\` (API routes, status codes, REST verbs), \`playwright\` (UI elements, interactions), or \`not-verifiable\` (cron, env vars, background processes, or too vague)
- Returns \`[]\` (not an error) when no acceptance criteria section is found
- Also exports \`extractHandoffTitle\` and \`extractFilePaths\` helpers for downstream context passing to Claude

## Files changed

- \`.github/actions/tlm-qa-agent/src/parse-criteria.ts\` (new)

## Acceptance Criteria
- \`parse-criteria.ts\` exports \`parseAcceptanceCriteria\` function that returns typed \`ParsedCriterion[]\` array
- Parser correctly extracts bullet-point criteria from a sample handoff v3 PR description
- Classification heuristic categorizes API route mentions as 'http', UI element mentions as 'playwright', and cron/env-var mentions as 'not-verifiable'
- Returns empty array (not error) when PR description has no acceptance criteria section"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/qa-agent-acceptance-criteria-parser
FILES CHANGED: .github/actions/tlm-qa-agent/src/parse-criteria.ts
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve autonomously (e.g., the `.github/actions/tlm-qa-agent/` directory doesn't exist and you cannot determine the correct structure, or tsconfig conflicts cause irresolvable errors):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "qa-agent-acceptance-criteria-parser",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": [".github/actions/tlm-qa-agent/src/parse-criteria.ts"]
    }
  }'
```