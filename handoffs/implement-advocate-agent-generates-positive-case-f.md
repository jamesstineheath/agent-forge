# Agent Forge -- Implement Advocate Agent

## Metadata
- **Branch:** `feat/debate-advocate-agent`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/debate/agents/advocate.ts

## Context

Agent Forge has an emerging debate subsystem for PR review. Two foundation files were recently merged:
- `lib/debate/types.ts` — defines `DebateArgument`, `DebateRound`, and related types
- `lib/debate/config.ts` — configuration schema for the debate system

The advocate agent is the first "player" in the debate loop. It reviews a PR diff and codebase context, then generates structured arguments FOR approving the changes. In subsequent rounds it enters rebuttal mode, addressing specific concerns raised by the critic agent.

The AI SDK pattern used elsewhere in this repo is `@ai-sdk/anthropic` with `generateText()`. The types `DebateArgument` and `DebateRound` are already defined in `lib/debate/types.ts` — the implementation must import from there.

**No files overlap with concurrent work** (`fix/disable-qa-agent-workflow-no-op-stub` touches only `.github/workflows/tlm-qa-agent.yml`).

## Requirements

1. Create `lib/debate/agents/advocate.ts` exporting `generateAdvocateArguments` and `buildAdvocatePrompt`
2. `generateAdvocateArguments` accepts `{ diff, prDescription, codebaseContext, previousRound? }` and returns `Promise<DebateArgument[]>`
3. All returned `DebateArgument` entries must have `position: 'advocate'`
4. Each argument must have a non-empty `claim` string, a non-empty `evidence` array, and `confidence` between 0 and 1 (inclusive)
5. When `previousRound` is provided, the prompt must include the critic's arguments from that round for rebuttal
6. Token usage from the AI SDK response must be tracked and returned alongside the arguments (either via a wrapper return type or attached metadata — see implementation note below)
7. `buildAdvocatePrompt` is a pure helper that constructs the full prompt string from diff, context, and optional prior round data
8. Claude is instructed via system prompt to identify: correct implementation patterns, good test coverage, adherence to codebase conventions, proper error handling, and clean abstractions
9. Structured output is parsed from Claude's text response into `DebateArgument[]`
10. File must compile with `npx tsc --noEmit` (strict mode, no new TS errors)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/debate-advocate-agent
```

### Step 1: Read existing type definitions

Read the existing types to ensure the implementation aligns exactly:

```bash
cat lib/debate/types.ts
cat lib/debate/config.ts
```

Note the exact shape of `DebateArgument` and `DebateRound`. The implementation must import and use those types without redefining them.

### Step 2: Understand the AI SDK pattern

Check how the AI SDK is used elsewhere in the repo:

```bash
grep -r "generateText\|@ai-sdk/anthropic\|createAnthropic" --include="*.ts" -l
grep -r "generateText" --include="*.ts" -A 10 | head -80
```

This will confirm the correct import style and model identifier used in this repo (likely `anthropic('claude-sonnet-4-5')` or similar).

### Step 3: Create the advocate agent

Create `lib/debate/agents/advocate.ts` with the following structure. Adjust type shapes after reading `lib/debate/types.ts` in Step 1:

```typescript
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import type { DebateArgument, DebateRound } from '../types';

export interface GenerateAdvocateArgumentsParams {
  diff: string;
  prDescription: string;
  codebaseContext: string;
  previousRound?: DebateRound;
}

export interface AdvocateResult {
  arguments: DebateArgument[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

const ADVOCATE_SYSTEM_PROMPT = `You are an advocate agent in a structured code review debate system. 
Your role is to build the strongest possible case FOR approving a pull request.

Analyze the PR diff and codebase context, then identify arguments supporting approval. Focus on:
- Correct implementation patterns that align with established conventions
- Adequate test coverage and test quality
- Adherence to the codebase's architectural patterns and naming conventions
- Proper error handling, edge case coverage, and defensive coding
- Clean abstractions, good separation of concerns, and maintainable code structure
- Performance considerations addressed appropriately
- Security best practices followed

When responding in rebuttal mode (critic arguments provided), you must directly address each critic 
concern, either refuting it with evidence or acknowledging it while explaining why approval is still warranted.

Respond ONLY with a JSON array of debate arguments. Each argument must follow this exact schema:
{
  "position": "advocate",
  "claim": "A clear, specific statement supporting the PR",
  "evidence": ["specific evidence item 1", "specific evidence item 2"],
  "confidence": 0.85
}

Rules:
- "position" must always be "advocate"
- "claim" must be a non-empty string
- "evidence" must be a non-empty array of strings with at least one item
- "confidence" must be a number between 0 and 1
- Return a JSON array with 2-5 arguments
- Do not wrap in markdown code fences or add any text outside the JSON array`;

export function buildAdvocatePrompt(params: {
  diff: string;
  prDescription: string;
  codebaseContext: string;
  previousRound?: DebateRound;
}): string {
  const { diff, prDescription, codebaseContext, previousRound } = params;

  let prompt = `## PR Description
${prDescription}

## Codebase Context
${codebaseContext}

## PR Diff
\`\`\`diff
${diff}
\`\`\`
`;

  if (previousRound) {
    const criticArguments = previousRound.arguments.filter(
      (arg) => arg.position === 'critic'
    );
    if (criticArguments.length > 0) {
      prompt += `\n## Critic Arguments to Rebut (Rebuttal Mode)
The critic raised the following concerns in the previous round. You must address each one:

${criticArguments
  .map(
    (arg, i) =>
      `### Critic Argument ${i + 1}
**Claim:** ${arg.claim}
**Evidence:** ${arg.evidence.join('; ')}
**Confidence:** ${arg.confidence}`
  )
  .join('\n\n')}

Address each of these concerns directly in your arguments.
`;
    }
  }

  prompt += `\nGenerate your advocate arguments as a JSON array:`;

  return prompt;
}

function parseDebateArguments(rawText: string): DebateArgument[] {
  // Strip markdown code fences if Claude wraps output despite instructions
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `Advocate agent returned non-JSON response: ${rawText.slice(0, 200)}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Advocate agent response is not an array');
  }

  return parsed.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`Argument at index ${index} is not an object`);
    }
    const arg = item as Record<string, unknown>;

    if (arg.position !== 'advocate') {
      throw new Error(
        `Argument at index ${index} has invalid position: ${arg.position}`
      );
    }
    if (typeof arg.claim !== 'string' || arg.claim.trim() === '') {
      throw new Error(
        `Argument at index ${index} has empty or missing claim`
      );
    }
    if (!Array.isArray(arg.evidence) || arg.evidence.length === 0) {
      throw new Error(
        `Argument at index ${index} has empty or missing evidence array`
      );
    }
    if (
      typeof arg.confidence !== 'number' ||
      arg.confidence < 0 ||
      arg.confidence > 1
    ) {
      throw new Error(
        `Argument at index ${index} has invalid confidence: ${arg.confidence}`
      );
    }

    // Cast to DebateArgument — adjust if DebateArgument has additional required fields
    return arg as unknown as DebateArgument;
  });
}

export async function generateAdvocateArguments(
  params: GenerateAdvocateArgumentsParams
): Promise<AdvocateResult> {
  const userPrompt = buildAdvocatePrompt(params);

  const result = await generateText({
    model: anthropic('claude-sonnet-4-5'),
    system: ADVOCATE_SYSTEM_PROMPT,
    prompt: userPrompt,
  });

  const debateArguments = parseDebateArguments(result.text);

  return {
    arguments: debateArguments,
    usage: {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
    },
  };
}
```

> **Implementation note:** `DebateArgument` in `lib/debate/types.ts` may use slightly different field names (e.g., `position` might be a union type, `evidence` might be typed differently). After reading the type in Step 1, adjust the implementation accordingly. If `DebateArgument` does not have a `position` field, add `position: 'advocate'` at the call site or wrap in an extension type. Do not alter `lib/debate/types.ts`.

### Step 4: Verify TypeScript compiles cleanly

```bash
npx tsc --noEmit
```

If there are type errors related to `DebateArgument` field shapes, revisit the cast in `parseDebateArguments` and align field names with what `lib/debate/types.ts` actually defines.

Common fixes:
- If `DebateArgument` uses `role` instead of `position` — update references
- If `evidence` is typed as `string` not `string[]` — adjust the evidence handling
- If the AI SDK model string differs — check `grep -r "anthropic(" --include="*.ts" | head -5`

### Step 5: Verify build

```bash
npm run build
```

Resolve any build errors before committing.

### Step 6: Commit, push, open PR

```bash
git add lib/debate/agents/advocate.ts
git commit -m "feat: implement advocate agent for PR debate system"
git push origin feat/debate-advocate-agent
gh pr create \
  --title "feat: implement advocate agent — generates positive case for PR" \
  --body "## Summary
Implements the advocate agent in the debate subsystem. This agent reviews a PR diff and codebase context to produce structured arguments supporting approval.

## Changes
- \`lib/debate/agents/advocate.ts\` — new file

## Features
- \`generateAdvocateArguments()\` — calls Claude via AI SDK, returns \`DebateArgument[]\` with tracked token usage
- \`buildAdvocatePrompt()\` — pure helper constructing the user prompt with optional rebuttal mode when \`previousRound\` is provided
- Validates all parsed arguments: position=advocate, non-empty claim, non-empty evidence array, confidence in [0,1]
- Gracefully strips markdown code fences from Claude output before JSON parse

## Test Coverage
No unit tests added in this PR — integration tested via TypeScript compilation. Unit tests can be added once the critic agent and debate runner are implemented (mocking the AI SDK).

## Related
Part of the debate subsystem. Depends on \`lib/debate/types.ts\` and \`lib/debate/config.ts\` (both merged)."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/debate-advocate-agent
FILES CHANGED: lib/debate/agents/advocate.ts
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If blocked on an unresolvable issue (e.g., `lib/debate/types.ts` does not exist yet, `DebateArgument` shape is incompatible with the described API, or the AI SDK version in `package.json` does not expose `usage` metadata):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "advocate-agent",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/debate/agents/advocate.ts"]
    }
  }'
```