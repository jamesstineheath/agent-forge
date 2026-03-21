# Agent Forge -- Create spike findings template and parser utility

## Metadata
- **Branch:** `feat/spike-findings-template-parser`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/spike-template.ts

## Context

Agent Forge recently added spike types and `SpikeRecommendation` enum to `lib/types.ts` (see recent merged PRs). This work item builds on that foundation by creating a utility module `lib/spike-template.ts` that:

1. Defines a `SpikeFindingsParsed` type for structured parsed output
2. Provides a `generateSpikeTemplate()` function to produce a markdown template for spike authors to fill in
3. Provides a `parseSpikeFindings()` function to extract structured data from a completed spike document

The `SpikeRecommendation` enum already exists in `lib/types.ts` — import from there rather than re-defining it. Check the exact export name/values by reading `lib/types.ts` before writing code.

## Requirements

1. `lib/spike-template.ts` exports a `SpikeFindingsParsed` type with fields: `parentPrdId: string`, `question: string`, `tried: string`, `findings: string`, `recommendation: SpikeRecommendation`, `implications: string`
2. `generateSpikeTemplate(metadata: SpikeMetadata): string` returns a markdown string containing all 6 required `##` headings: `## Parent PRD`, `## Technical Question`, `## What Was Tried`, `## Detailed Findings`, `## Recommendation (GO / GO_WITH_CHANGES / NO_GO)`, `## Implications for Parent PRD`
3. `parseSpikeFindings(markdown: string): SpikeFindingsParsed` parses a completed spike markdown document and returns a `SpikeFindingsParsed` object
4. Parser correctly extracts `SpikeRecommendation` enum value from the Recommendation section, handling all three values: `GO`, `GO_WITH_CHANGES`, `NO_GO`
5. Parser correctly extracts all other fields: `parentPrdId`, `question`, `tried`, `findings`, `implications`
6. Parser is tolerant of minor formatting variations (extra whitespace, mixed case recommendation values, optional trailing content after the enum value on the recommendation line)
7. TypeScript compiles without errors (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/spike-findings-template-parser
```

### Step 1: Read existing types

Before writing any code, read `lib/types.ts` to understand the exact shape of `SpikeRecommendation` and `SpikeMetadata` (if it exists). Note the exact enum values and import paths.

```bash
cat lib/types.ts
```

### Step 2: Create `lib/spike-template.ts`

Create the file with the following structure. Adjust imports based on what you found in Step 1.

```typescript
import { SpikeRecommendation, SpikeMetadata } from './types';

// If SpikeMetadata does not exist in lib/types.ts, define it locally:
// type SpikeMetadata = { parentPrdId: string; question: string; [key: string]: unknown };

export type SpikeFindingsParsed = {
  parentPrdId: string;
  question: string;
  tried: string;
  findings: string;
  recommendation: SpikeRecommendation;
  implications: string;
};

export function generateSpikeTemplate(metadata: SpikeMetadata): string {
  return `## Parent PRD
${metadata.parentPrdId ?? ''}

## Technical Question
${metadata.question ?? ''}

## What Was Tried
<!-- Describe the approaches, experiments, or research conducted -->

## Detailed Findings
<!-- Summarize what was discovered, including relevant data, code snippets, or links -->

## Recommendation (GO / GO_WITH_CHANGES / NO_GO)
<!-- State one of: GO, GO_WITH_CHANGES, NO_GO -->

## Implications for Parent PRD
<!-- Describe how these findings affect the parent PRD scope, design, or timeline -->
`;
}

export function parseSpikeFindings(markdown: string): SpikeFindingsParsed {
  // Extract content between ## headings
  const sectionRegex = /^##\s+(.+?)$([\s\S]*?)(?=^##\s|\s*$)/gm;

  const sections: Record<string, string> = {};
  let match: RegExpExecArray | null;

  while ((match = sectionRegex.exec(markdown)) !== null) {
    const heading = match[1].trim();
    const content = match[2].trim();
    sections[heading] = content;
  }

  // Helper: extract section content by partial heading match (case-insensitive)
  function getSection(keyPattern: RegExp): string {
    for (const [heading, content] of Object.entries(sections)) {
      if (keyPattern.test(heading)) {
        return content;
      }
    }
    return '';
  }

  // Extract parentPrdId
  const parentPrdId = getSection(/parent\s+prd/i);

  // Extract question
  const question = getSection(/technical\s+question/i);

  // Extract tried
  const tried = getSection(/what\s+was\s+tried/i);

  // Extract findings
  const findings = getSection(/detailed\s+findings/i);

  // Extract implications
  const implications = getSection(/implications/i);

  // Extract recommendation - look for GO_WITH_CHANGES, NO_GO, or GO
  // (order matters: check GO_WITH_CHANGES before GO to avoid partial match)
  const rawRecommendation = getSection(/recommendation/i);
  let recommendation: SpikeRecommendation;

  const recUpper = rawRecommendation.toUpperCase().replace(/[\s\-]+/g, '_');

  if (recUpper.includes('GO_WITH_CHANGES') || recUpper.includes('GO WITH CHANGES'.replace(/ /g, '_'))) {
    recommendation = SpikeRecommendation.GO_WITH_CHANGES;
  } else if (recUpper.includes('NO_GO') || recUpper.includes('NOGO')) {
    recommendation = SpikeRecommendation.NO_GO;
  } else if (recUpper.includes('GO')) {
    recommendation = SpikeRecommendation.GO;
  } else {
    // Default / fallback — throw to surface malformed documents
    throw new Error(
      `parseSpikeFindings: could not extract SpikeRecommendation from section content: "${rawRecommendation}"`
    );
  }

  return {
    parentPrdId,
    question,
    tried,
    findings,
    recommendation,
    implications,
  };
}
```

**Important implementation notes:**
- If `SpikeMetadata` is not exported from `lib/types.ts`, define a local minimal type in `spike-template.ts` rather than modifying `lib/types.ts` (keep changes minimal).
- If `SpikeRecommendation` is a plain string union (e.g., `'GO' | 'GO_WITH_CHANGES' | 'NO_GO'`) rather than a TypeScript enum, adjust the recommendation extraction logic accordingly — use string literals instead of enum member access.
- The section regex must handle the edge case where the last section has no following `##` heading. Test that the regex captures content until EOF.

### Step 3: Verify section regex handles EOF edge case

The regex `/^##\s+(.+?)$([\s\S]*?)(?=^##\s|\s*$)/gm` uses a lookahead that may not capture the last section correctly. If the last section is empty or truncated, adjust the regex to:

```typescript
// Split on ## headings instead of using a complex regex
function extractSections(markdown: string): Record<string, string> {
  const sections: Record<string, string> = {};
  // Split the document at every line starting with "## "
  const parts = markdown.split(/^(?=##\s)/m);
  for (const part of parts) {
    const lines = part.split('\n');
    const headingLine = lines[0].trim();
    if (/^##\s/.test(headingLine)) {
      const heading = headingLine.replace(/^##\s+/, '').trim();
      const content = lines.slice(1).join('\n').trim();
      sections[heading] = content;
    }
  }
  return sections;
}
```

Use this split-based approach as it is simpler and more reliable than the regex lookahead approach. Refactor `parseSpikeFindings` to call this helper.

### Step 4: TypeScript check

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- If `SpikeRecommendation` is not an enum with `.GO`, `.GO_WITH_CHANGES`, `.NO_GO` members, use the appropriate string literal or const values.
- If `SpikeMetadata` doesn't exist in `lib/types.ts`, add a local type definition.

### Step 5: Quick smoke test (optional but recommended)

Create a temporary test script to verify the round-trip works:

```bash
cat > /tmp/spike-smoke.ts << 'EOF'
import { generateSpikeTemplate, parseSpikeFindings } from './lib/spike-template';
import { SpikeRecommendation } from './lib/types';

const metadata = { parentPrdId: 'PRD-001', question: 'Can we use X?' };
const template = generateSpikeTemplate(metadata as any);
console.log('Generated template:\n', template);

const filled = template
  .replace('<!-- State one of: GO, GO_WITH_CHANGES, NO_GO -->', 'GO_WITH_CHANGES - proceed with caveats')
  .replace('<!-- Describe the approaches', 'Used library X and Y')
  .replace('<!-- Summarize what was discovered', 'Library X works but has latency')
  .replace('<!-- Describe how these findings', 'Timeline extends by 1 sprint');

const parsed = parseSpikeFindings(filled);
console.log('Parsed:', JSON.stringify(parsed, null, 2));
console.assert(parsed.recommendation === SpikeRecommendation.GO_WITH_CHANGES, 'Wrong recommendation');
console.log('Smoke test passed ✓');
EOF
npx ts-node /tmp/spike-smoke.ts 2>&1 || echo "ts-node not available, skipping smoke test"
rm -f /tmp/spike-smoke.ts
```

### Step 6: Final build check

```bash
npm run build 2>&1 | tail -20
```

If build fails for reasons unrelated to this file (pre-existing failures), note them in the PR description but do not block.

### Step 7: Commit, push, open PR

```bash
git add lib/spike-template.ts
git commit -m "feat: add spike findings template and parser utility

- Add SpikeFindingsParsed type with all required fields
- Add generateSpikeTemplate() returning markdown with 6 required sections
- Add parseSpikeFindings() with section-split parser
- Parser handles all three SpikeRecommendation values (GO, GO_WITH_CHANGES, NO_GO)
- Parser tolerant of formatting variations and partial matches"

git push origin feat/spike-findings-template-parser

gh pr create \
  --title "feat: add spike findings template and parser utility" \
  --body "## Summary

Adds \`lib/spike-template.ts\` with:

- **\`SpikeFindingsParsed\`** type with fields: \`parentPrdId\`, \`question\`, \`tried\`, \`findings\`, \`recommendation\`, \`implications\`
- **\`generateSpikeTemplate(metadata)\`** → markdown string with all 6 required \`##\` sections
- **\`parseSpikeFindings(markdown)\`** → structured \`SpikeFindingsParsed\` object

### Parser behavior
- Splits document on \`## \` headings (robust to EOF edge cases)
- Extracts \`SpikeRecommendation\` via priority matching: \`GO_WITH_CHANGES\` → \`NO_GO\` → \`GO\`
- Case-insensitive, whitespace-tolerant heading and recommendation matching
- Throws descriptive error if recommendation cannot be extracted

### Acceptance criteria
- [x] \`generateSpikeTemplate()\` returns markdown with all 6 required \`##\` headings
- [x] \`parseSpikeFindings()\` extracts \`SpikeRecommendation\` from well-formed document
- [x] All fields extracted: \`parentPrdId\`, \`question\`, \`tried\`, \`findings\`, \`implications\`
- [x] All three recommendation values handled: GO, GO_WITH_CHANGES, NO_GO
- [x] TypeScript compiles without errors

## Files changed
- \`lib/spike-template.ts\` (new)"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/spike-findings-template-parser
FILES CHANGED: [lib/spike-template.ts]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If blocked by an unresolvable issue (e.g., `SpikeRecommendation` doesn't exist in `lib/types.ts` and the shape is unclear, or `SpikeMetadata` has a required shape that conflicts with this implementation), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "create-spike-findings-template-parser",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message>",
      "filesChanged": ["lib/spike-template.ts"]
    }
  }'
```