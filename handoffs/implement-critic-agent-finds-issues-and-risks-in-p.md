# Agent Forge -- Implement critic agent — finds issues and risks in PR

## Metadata
- **Branch:** `feat/implement-critic-agent-finds-issues-and-risks`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/debate/agents/critic.ts

## Context

Agent Forge is adding a debate-style PR review system where two agents (advocate and critic) argue about a PR's merits. This task implements the **critic agent** — the counterpart to the advocate agent (being built concurrently on branch `fix/implement-advocate-agent-generates-positive-case-f`).

The debate system's types and configuration schema have already been merged (see recent PRs). The types live in `lib/debate/types.ts` and `lib/debate/config.ts`. The critic agent must integrate with these existing types, specifically `DebateArgument` and `DebateRound`.

The critic agent finds weaknesses in a PR: bugs, edge cases, missing tests, security issues, performance concerns, convention violations, and incomplete error handling. It also supports counter-rebuttal mode when given a `previousRound` context.

**Key constraint:** Do not touch `lib/debate/agents/advocate.ts` — that file is owned by a concurrent work item.

## Requirements

1. Create `lib/debate/agents/critic.ts` exporting `async function generateCriticArguments(params: { diff: string, prDescription: string, codebaseContext: string, previousRound?: DebateRound }): Promise<DebateArgument[]>`
2. All returned `DebateArgument` objects must have `position: 'critic'`
3. Use Anthropic Claude via `@ai-sdk/anthropic` with `generateText()` from the `ai` package
4. Export a `buildCriticPrompt()` helper function that constructs the prompt string
5. When `previousRound` is provided, the prompt must include advocate arguments for counter-rebuttal mode
6. Each returned argument must include: non-empty `claim`, non-empty `evidence` array, and `confidence` between 0 and 1
7. Arguments must be ordered by severity: security > correctness > performance > style
8. Track token usage via the AI SDK's usage metadata (log it)
9. System prompt instructs the agent to find: bugs, edge cases, missing tests, security issues, performance concerns, convention violations, incomplete error handling
10. Parse Claude's structured text output into `DebateArgument[]`

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/implement-critic-agent-finds-issues-and-risks
```

### Step 1: Inspect existing debate types

Read the existing types to understand the exact interfaces:

```bash
cat lib/debate/types.ts
cat lib/debate/config.ts
```

Pay close attention to:
- The `DebateArgument` interface (fields: `position`, `claim`, `evidence`, `confidence`, and any others)
- The `DebateRound` interface (fields: likely contains arrays of `DebateArgument` from both sides)
- Any enums or union types for `position`, severity categories, etc.

Also check what's already in the agents directory (if it exists):
```bash
ls lib/debate/agents/ 2>/dev/null || echo "agents dir does not exist yet"
```

### Step 2: Create the agents directory if needed

```bash
mkdir -p lib/debate/agents
```

### Step 3: Implement `lib/debate/agents/critic.ts`

Create the file with the following structure (adapt field names to match actual types from Step 1):

```typescript
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import type { DebateArgument, DebateRound } from '../types';

// Severity ordering for sorting critic arguments
const SEVERITY_ORDER: Record<string, number> = {
  security: 0,
  correctness: 1,
  performance: 2,
  style: 3,
};

interface CriticParams {
  diff: string;
  prDescription: string;
  codebaseContext: string;
  previousRound?: DebateRound;
}

export function buildCriticPrompt(params: CriticParams): string {
  const { diff, prDescription, codebaseContext, previousRound } = params;

  let prompt = `You are a rigorous code reviewer acting as the CRITIC in a structured PR debate.

Your task is to identify weaknesses, risks, and improvement opportunities in the following pull request.

## PR Description
${prDescription}

## Codebase Context
${codebaseContext}

## Diff
\`\`\`
${diff}
\`\`\`
`;

  if (previousRound) {
    const advocateArgs = previousRound.advocateArguments ?? previousRound.arguments?.filter(
      (a: DebateArgument) => a.position === 'advocate'
    ) ?? [];

    if (advocateArgs.length > 0) {
      prompt += `
## Advocate's Previous Arguments (Counter-Rebuttal Mode)
The advocate has made the following claims in favor of this PR. You must directly address and rebut these arguments:

${advocateArgs.map((arg: DebateArgument, i: number) =>
  `${i + 1}. CLAIM: ${arg.claim}\n   EVIDENCE: ${arg.evidence.join('; ')}\n   CONFIDENCE: ${arg.confidence}`
).join('\n\n')}

In counter-rebuttal mode, your arguments should specifically address why the advocate's claims are insufficient, overstated, or miss important risks.
`;
    }
  }

  prompt += `
## Instructions
Identify all significant issues in this PR. For each issue, analyze:
- **Security**: Authentication bypasses, injection vulnerabilities, exposed secrets, insecure data handling
- **Correctness**: Bugs, edge cases, off-by-one errors, null/undefined handling, race conditions
- **Performance**: Unnecessary re-renders, N+1 queries, missing memoization, expensive operations in hot paths
- **Style**: Convention violations, missing documentation, inconsistent naming, dead code

## Required Output Format
Return a JSON array of objects. Each object MUST have these exact fields:
- "claim": string — a specific, concrete assertion about a problem (non-empty)
- "evidence": string[] — array of specific code locations, line references, or reasoning (non-empty)
- "confidence": number — your confidence this is a real issue, between 0.0 and 1.0
- "category": string — one of: "security", "correctness", "performance", "style"
- "position": "critic" — always this literal value
- "severity": string — one of: "high", "medium", "low"

Return ONLY the JSON array, no additional text. If you find no issues, return an empty array [].

Example:
[
  {
    "claim": "The authentication check is skipped when userId is null",
    "evidence": ["Line 42: if (userId) { ... } — falsy check misses empty string case", "Missing test for empty string userId"],
    "confidence": 0.9,
    "category": "security",
    "position": "critic",
    "severity": "high"
  }
]
`;

  return prompt;
}

function parseCriticResponse(text: string): DebateArgument[] {
  // Strip markdown code fences if present
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed: unknown[];
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Attempt to extract JSON array from the text
    const match = stripped.match(/\[[\s\S]*\]/);
    if (!match) {
      console.error('[critic] Failed to parse Claude response as JSON:', stripped.slice(0, 500));
      return [];
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      console.error('[critic] Failed to extract JSON array from response');
      return [];
    }
  }

  if (!Array.isArray(parsed)) {
    console.error('[critic] Claude response was not an array');
    return [];
  }

  const args: DebateArgument[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;

    const claim = typeof obj.claim === 'string' ? obj.claim.trim() : '';
    const evidence = Array.isArray(obj.evidence)
      ? obj.evidence.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
      : [];
    const confidence =
      typeof obj.confidence === 'number'
        ? Math.max(0, Math.min(1, obj.confidence))
        : 0.5;

    if (!claim || evidence.length === 0) {
      console.warn('[critic] Skipping argument with empty claim or evidence:', obj);
      continue;
    }

    // Build the DebateArgument — include all fields from the type
    // Spread obj first, then override required fields to ensure compliance
    args.push({
      ...obj,
      claim,
      evidence,
      confidence,
      position: 'critic',
    } as DebateArgument);
  }

  return args;
}

function sortBySeverityCategory(args: DebateArgument[]): DebateArgument[] {
  return [...args].sort((a, b) => {
    // Access category field — it may be directly on the object
    const catA = (a as Record<string, unknown>).category as string | undefined;
    const catB = (b as Record<string, unknown>).category as string | undefined;
    const orderA = catA !== undefined ? (SEVERITY_ORDER[catA] ?? 99) : 99;
    const orderB = catB !== undefined ? (SEVERITY_ORDER[catB] ?? 99) : 99;
    return orderA - orderB;
  });
}

export async function generateCriticArguments(
  params: CriticParams
): Promise<DebateArgument[]> {
  const prompt = buildCriticPrompt(params);

  console.log('[critic] Generating critic arguments...');

  const result = await generateText({
    model: anthropic('claude-3-5-sonnet-20241022'),
    system:
      'You are a rigorous code critic. Your job is to find real problems, not nitpick for the sake of it. Be specific, cite evidence, and be honest about your confidence level. Output only valid JSON.',
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    temperature: 0.2,
    maxTokens: 4096,
  });

  // Log token usage
  if (result.usage) {
    console.log('[critic] Token usage:', {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
    });
  }

  const rawArguments = parseCriticResponse(result.text);
  const sorted = sortBySeverityCategory(rawArguments);

  console.log(`[critic] Generated ${sorted.length} critic arguments`);
  return sorted;
}
```

### Step 4: Verify the implementation compiles

```bash
npx tsc --noEmit
```

If there are type errors related to `DebateArgument` or `DebateRound`, open `lib/debate/types.ts` and adjust the field accesses in `critic.ts` to match the actual interface. Common issues:
- The `position` field may be typed as a union `'advocate' | 'critic'` — ensure the spread + override pattern satisfies TypeScript
- `DebateRound` may store advocate/critic arguments under different field names — adjust `previousRound.advocateArguments` access accordingly
- If `category` is part of `DebateArgument`, remove the cast to `Record<string, unknown>` for that access

### Step 5: Check that imports resolve

```bash
# Verify @ai-sdk/anthropic and ai are installed
cat package.json | grep -E '"ai"|"@ai-sdk'
```

If either package is missing:
```bash
npm install ai @ai-sdk/anthropic
```

### Step 6: Run existing tests

```bash
npm test 2>&1 | head -80
```

Ensure no existing tests are broken by the new file.

### Step 7: Verification

```bash
npx tsc --noEmit
npm run build 2>&1 | tail -20
npm test 2>&1 | tail -30
```

### Step 8: Commit, push, open PR

```bash
git add lib/debate/agents/critic.ts
git commit -m "feat: implement critic agent for PR debate system

- Add generateCriticArguments() that uses Claude to find issues in PRs
- Add buildCriticPrompt() helper with counter-rebuttal mode support
- Arguments ordered by severity: security > correctness > performance > style
- All arguments have position='critic' and include claim, evidence, confidence
- Token usage logged via AI SDK usage metadata"

git push origin feat/implement-critic-agent-finds-issues-and-risks

gh pr create \
  --title "feat: implement critic agent — finds issues and risks in PR" \
  --body "## Summary
Implements the critic agent for the PR debate system.

## Changes
- **\`lib/debate/agents/critic.ts\`** (new): Critic agent that uses Claude to identify weaknesses in PRs

## Features
- \`generateCriticArguments()\`: Calls Claude via AI SDK, returns \`DebateArgument[]\` with \`position='critic'\`
- \`buildCriticPrompt()\`: Constructs the prompt, supports counter-rebuttal mode when \`previousRound\` is provided
- Arguments ordered by severity category: security > correctness > performance > style
- Handles bugs, edge cases, missing tests, security issues, performance concerns, convention violations, error handling gaps
- Token usage logged for observability
- Robust JSON parsing with fallback extraction

## Acceptance Criteria Verified
- [x] All returned arguments have \`position='critic'\`
- [x] Counter-rebuttal mode includes advocate arguments in prompt when \`previousRound\` provided
- [x] Each argument has non-empty \`claim\`, non-empty \`evidence\` array, \`confidence\` in [0,1]
- [x] Arguments sorted: security > correctness > performance > style
- [x] \`buildCriticPrompt()\` produces valid prompt with diff, context, optional prior round

## Concurrency Note
Does not touch \`lib/debate/agents/advocate.ts\` (owned by concurrent branch \`fix/implement-advocate-agent-generates-positive-case-f\`)." \
  --base main
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/implement-critic-agent-finds-issues-and-risks
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve autonomously (e.g., `DebateArgument` or `DebateRound` types don't exist yet in `lib/debate/types.ts`, the `@ai-sdk/anthropic` package is absent and you cannot install it, or there are architectural ambiguities about how critic arguments integrate into the debate round):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "implement-critic-agent-finds-issues-and-risks",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/debate/agents/critic.ts"]
    }
  }'
```