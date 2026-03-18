# Agent Forge -- Implement judge agent — synthesizes debate into verdict

## Metadata
- **Branch:** `feat/implement-judge-agent-synthesizes-debate-into-verdi`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/debate/agents/judge.ts

## Context

Agent Forge is a dev orchestration platform built with Next.js. A debate system is being built under `lib/debate/` where an advocate agent and critic agent debate the merits of a PR, and a judge agent synthesizes their exchange into a final verdict.

The advocate agent (`lib/debate/agents/advocate.ts`) generates the positive case for a PR. The critic agent (`lib/debate/agents/critic.ts`) finds issues and risks. The judge agent (this work item) synthesizes all debate rounds into a final `DebateOutcome`.

**Note on concurrent work:** The critic agent is being implemented on branch `fix/implement-critic-agent-finds-issues-and-risks-in-p` in `lib/debate/agents/critic.ts`. Do NOT modify that file. This task only touches `lib/debate/agents/judge.ts`.

The codebase uses the Anthropic Claude API via `@ai-sdk/anthropic` and the `ai` package's `generateText()` function. Refer to existing agents (advocate, critic) for the established pattern.

### Existing Pattern (from advocate/critic agents)

Based on the repo's tech stack and recent merged PRs, the pattern for debate agents is:
- Import `generateText` from `ai` and `createAnthropic` or `anthropic` from `@ai-sdk/anthropic`
- Accept a typed params object, return a typed result
- Build a system prompt and user prompt via helper functions
- Map LLM output to the return type

### Types to infer/define

Since `lib/debate/types.ts` (or similar) may already exist or need to be created alongside this work, define the required types inline in the judge file if they don't already exist. The key types needed:

```typescript
// DebateRound — one exchange between advocate and critic
interface DebateRound {
  roundNumber: number;
  advocateArgument: string;
  criticArgument: string;
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

// DebateConfig — controls debate behavior
interface DebateConfig {
  maxRounds: number;
  confidenceThreshold: number; // 0-1, e.g. 0.8
  model?: string;
}

// DebateOutcome — judge's final synthesis
interface DebateOutcome {
  finalVerdict: 'approve' | 'request_changes' | 'escalate';
  reasoning: string;
  resolvedIssues: string[];
  unresolvedDisagreements: string[];
  consensus: boolean;
  confidenceScore: number; // 0-1
  tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
}
```

Check `lib/debate/` for any existing type definitions and reuse them if present. If `lib/debate/types.ts` exists, import from there rather than redefining.

## Requirements

1. Create `lib/debate/agents/judge.ts` with the judge agent implementation
2. Export `async function evaluateDebate(params: { rounds: DebateRound[], diff: string, prDescription: string, codebaseContext: string, config: DebateConfig }): Promise<DebateOutcome>`
3. Export `function shouldContinueDebate(outcome: DebateOutcome, config: DebateConfig, currentRound: number): boolean`
4. Export `function buildJudgePrompt(params: { rounds: DebateRound[], diff: string, prDescription: string, codebaseContext: string }): string` helper
5. Use `generateText()` from `ai` package with an Anthropic model
6. System prompt instructs the judge to: weigh arguments by evidence quality and confidence, identify resolved vs unresolved disagreements, determine if confidence threshold is met for a verdict
7. Verdict logic:
   - If unresolved security or correctness issues → `'request_changes'`
   - If all issues resolved or only low-severity issues remain → `'approve'`
   - If unable to determine → `'escalate'`
8. Consensus detection: if advocate and critic converge (both reference the same resolution in their final round), set `consensus: true`
9. Token usage in `DebateOutcome` must aggregate tokens from all provided `rounds` PLUS tokens from the judge's own LLM call
10. `shouldContinueDebate` returns `false` when `currentRound >= config.maxRounds`
11. `shouldContinueDebate` returns `false` when `outcome.consensus === true`
12. `shouldContinueDebate` returns `false` when `outcome.unresolvedDisagreements.length === 0`
13. `shouldContinueDebate` returns `true` only when all three conditions above are NOT met
14. The file must compile with no TypeScript errors (`npx tsc --noEmit`)
15. Do not modify any files outside `lib/debate/agents/judge.ts` (and optionally `lib/debate/types.ts` if adding shared types there)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/implement-judge-agent-synthesizes-debate-into-verdi
```

### Step 1: Inspect existing debate infrastructure

Check what already exists to avoid duplicating types:

```bash
ls lib/debate/ 2>/dev/null || echo "lib/debate/ does not exist"
ls lib/debate/agents/ 2>/dev/null || echo "lib/debate/agents/ does not exist"
cat lib/debate/types.ts 2>/dev/null || echo "No types.ts found"
cat lib/debate/agents/advocate.ts 2>/dev/null || echo "No advocate.ts found"
# Do NOT cat critic.ts as it may be on a different branch / in-flight
```

Use the output to:
- Determine if `DebateRound`, `DebateConfig`, `DebateOutcome` types already exist
- Understand the import pattern used by advocate (same pattern to follow)
- Identify the correct model string (e.g., `'claude-3-5-sonnet-20241022'` or env-driven)

### Step 2: Create directory structure if needed

```bash
mkdir -p lib/debate/agents
```

### Step 3: Implement `lib/debate/agents/judge.ts`

Create the file. Below is a reference implementation — adjust imports and type locations based on what you found in Step 1:

```typescript
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

// ── Types ──────────────────────────────────────────────────────────────────
// Import from lib/debate/types.ts if it exists, otherwise define here.

export interface DebateRound {
  roundNumber: number;
  advocateArgument: string;
  criticArgument: string;
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface DebateConfig {
  maxRounds: number;
  confidenceThreshold: number; // 0–1, e.g. 0.8
  model?: string;
}

export interface DebateOutcome {
  finalVerdict: 'approve' | 'request_changes' | 'escalate';
  reasoning: string;
  resolvedIssues: string[];
  unresolvedDisagreements: string[];
  consensus: boolean;
  confidenceScore: number; // 0–1
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ── Prompt helpers ─────────────────────────────────────────────────────────

const JUDGE_SYSTEM_PROMPT = `You are an impartial senior engineer acting as a debate judge for code review.

Your role is to evaluate a structured debate between an advocate (arguing in favor of a PR) and a critic (identifying risks and issues), then synthesize a final verdict.

When evaluating:
1. Weigh arguments by evidence quality and confidence — specific, concrete concerns outweigh vague ones
2. Identify which disagreements have been resolved (both parties acknowledge a resolution) vs which remain open
3. Detect consensus: if the advocate and critic converge and both reference the same resolution in their most recent exchange, that constitutes consensus
4. Assess the severity of unresolved issues: security and correctness issues are blocking; style and minor performance issues are non-blocking

Verdict rules:
- 'request_changes': one or more unresolved security or correctness issues remain
- 'approve': all issues are resolved OR only low-severity (style, minor) issues remain
- 'escalate': you are genuinely unable to determine the right verdict due to ambiguity or missing information

Respond ONLY with valid JSON matching this schema:
{
  "finalVerdict": "approve" | "request_changes" | "escalate",
  "reasoning": "<concise explanation of the verdict>",
  "resolvedIssues": ["<issue that was raised and resolved>", ...],
  "unresolvedDisagreements": ["<issue that remains unresolved>", ...],
  "consensus": true | false,
  "confidenceScore": <0.0–1.0>
}`;

export function buildJudgePrompt(params: {
  rounds: DebateRound[];
  diff: string;
  prDescription: string;
  codebaseContext: string;
}): string {
  const { rounds, diff, prDescription, codebaseContext } = params;

  const roundsText = rounds
    .map(
      (r) => `--- Round ${r.roundNumber} ---
Advocate: ${r.advocateArgument}

Critic: ${r.criticArgument}`
    )
    .join('\n\n');

  return `## PR Description
${prDescription}

## Code Diff
\`\`\`diff
${diff}
\`\`\`

## Codebase Context
${codebaseContext}

## Debate Transcript
${roundsText}

## Task
Evaluate the debate above and produce a final verdict JSON as instructed.`;
}

// ── Token aggregation helper ───────────────────────────────────────────────

function aggregateRoundTokens(rounds: DebateRound[]): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  return rounds.reduce(
    (acc, round) => {
      if (round.tokenUsage) {
        acc.promptTokens += round.tokenUsage.promptTokens;
        acc.completionTokens += round.tokenUsage.completionTokens;
        acc.totalTokens += round.tokenUsage.totalTokens;
      }
      return acc;
    },
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  );
}

// ── Main export ────────────────────────────────────────────────────────────

export async function evaluateDebate(params: {
  rounds: DebateRound[];
  diff: string;
  prDescription: string;
  codebaseContext: string;
  config: DebateConfig;
}): Promise<DebateOutcome> {
  const { rounds, diff, prDescription, codebaseContext, config } = params;

  const model = config.model ?? 'claude-3-5-sonnet-20241022';
  const userPrompt = buildJudgePrompt({ rounds, diff, prDescription, codebaseContext });

  const result = await generateText({
    model: anthropic(model),
    system: JUDGE_SYSTEM_PROMPT,
    prompt: userPrompt,
  });

  // Parse the JSON response
  let parsed: {
    finalVerdict: 'approve' | 'request_changes' | 'escalate';
    reasoning: string;
    resolvedIssues: string[];
    unresolvedDisagreements: string[];
    consensus: boolean;
    confidenceScore: number;
  };

  try {
    // Strip markdown code fences if present
    const raw = result.text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    parsed = JSON.parse(raw);
  } catch {
    // Fallback: if JSON parsing fails, escalate
    parsed = {
      finalVerdict: 'escalate',
      reasoning: `Judge failed to parse LLM response: ${result.text.slice(0, 200)}`,
      resolvedIssues: [],
      unresolvedDisagreements: ['Unable to parse judge output'],
      consensus: false,
      confidenceScore: 0,
    };
  }

  // Validate finalVerdict is one of the allowed values
  const allowedVerdicts = ['approve', 'request_changes', 'escalate'] as const;
  if (!allowedVerdicts.includes(parsed.finalVerdict)) {
    parsed.finalVerdict = 'escalate';
  }

  // Aggregate token usage: all rounds + this judge call
  const roundTokens = aggregateRoundTokens(rounds);
  const judgePromptTokens = result.usage?.promptTokens ?? 0;
  const judgeCompletionTokens = result.usage?.completionTokens ?? 0;

  const tokenUsage = {
    promptTokens: roundTokens.promptTokens + judgePromptTokens,
    completionTokens: roundTokens.completionTokens + judgeCompletionTokens,
    totalTokens:
      roundTokens.totalTokens + judgePromptTokens + judgeCompletionTokens,
  };

  return {
    finalVerdict: parsed.finalVerdict,
    reasoning: parsed.reasoning ?? '',
    resolvedIssues: Array.isArray(parsed.resolvedIssues) ? parsed.resolvedIssues : [],
    unresolvedDisagreements: Array.isArray(parsed.unresolvedDisagreements)
      ? parsed.unresolvedDisagreements
      : [],
    consensus: Boolean(parsed.consensus),
    confidenceScore:
      typeof parsed.confidenceScore === 'number'
        ? Math.max(0, Math.min(1, parsed.confidenceScore))
        : 0,
    tokenUsage,
  };
}

// ── Debate continuation logic ──────────────────────────────────────────────

export function shouldContinueDebate(
  outcome: DebateOutcome,
  config: DebateConfig,
  currentRound: number
): boolean {
  // Stop if max rounds reached
  if (currentRound >= config.maxRounds) {
    return false;
  }

  // Stop if consensus was reached
  if (outcome.consensus) {
    return false;
  }

  // Stop if no unresolved disagreements remain
  if (outcome.unresolvedDisagreements.length === 0) {
    return false;
  }

  return true;
}
```

**Important adjustments based on Step 1 findings:**
- If `lib/debate/types.ts` already defines `DebateRound`, `DebateConfig`, or `DebateOutcome`, import them from there instead of redefining. Remove the local interface definitions for any types already defined there.
- If advocate.ts uses a different import for the anthropic model (e.g., `import { createAnthropic } from '@ai-sdk/anthropic'`), match that pattern.
- If the advocate uses a different model string, use the same one for consistency.

### Step 4: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- If `result.usage` has a different shape in your version of the `ai` package, check the actual type (may be `result.usage.promptTokens` or `result.usage.prompt_tokens`). Inspect with: `cat node_modules/ai/dist/index.d.ts | grep -A5 'usage'` or just use optional chaining and nullish coalescing.
- If `@ai-sdk/anthropic` exports differently, check: `cat node_modules/@ai-sdk/anthropic/dist/index.d.ts | grep export`

### Step 5: Run build

```bash
npm run build
```

Address any build errors. The judge module should tree-shake cleanly since it has no side effects.

### Step 6: Commit, push, open PR

```bash
git add lib/debate/agents/judge.ts
git commit -m "feat: implement judge agent — synthesizes debate into verdict"
git push origin feat/implement-judge-agent-synthesizes-debate-into-verdi
gh pr create \
  --title "feat: implement judge agent — synthesizes debate into verdict" \
  --body "## Summary

Implements the judge agent that synthesizes advocate/critic debate rounds into a final verdict.

## Changes
- \`lib/debate/agents/judge.ts\` — new file

## Key behaviors
- \`evaluateDebate()\`: calls Claude to weigh debate rounds, detect consensus, classify verdict as \`approve\` / \`request_changes\` / \`escalate\`
- \`shouldContinueDebate()\`: returns false when max rounds reached, consensus achieved, or no unresolved disagreements remain
- \`buildJudgePrompt()\`: formats rounds transcript + diff + PR description for the LLM
- Token usage aggregates across all debate rounds plus the judge's own inference call
- JSON parse failure degrades gracefully to \`escalate\` verdict

## Acceptance criteria met
- [x] evaluateDebate returns DebateOutcome with valid finalVerdict
- [x] DebateOutcome includes resolvedIssues and unresolvedDisagreements arrays
- [x] Token usage aggregates across all provided rounds + judge call
- [x] shouldContinueDebate returns false when currentRound >= config.maxRounds
- [x] shouldContinueDebate returns false when outcome.consensus is true
- [x] shouldContinueDebate returns false when unresolvedDisagreements is empty

## Concurrent work note
Does not touch \`lib/debate/agents/critic.ts\` (concurrent work item on separate branch)."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/implement-judge-agent-synthesizes-debate-into-verdi
FILES CHANGED: lib/debate/agents/judge.ts
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If a blocker cannot be resolved autonomously (e.g., missing type definitions that conflict with concurrent work, ambiguous `ai` package API shape, or repeated TypeScript errors after 3 fix attempts), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "implement-judge-agent-synthesizes-debate-into-verdict",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/debate/agents/judge.ts"]
    }
  }'
```