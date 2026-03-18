# Agent Forge -- Implement debate orchestrator — runs multi-round debate loop

## Metadata
- **Branch:** `feat/implement-debate-orchestrator`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/debate/orchestrator.ts

## Context

Agent Forge is a dev orchestration platform built on Next.js. A multi-agent debate system is being built to provide richer PR reviews. The system consists of:

- **Advocate agent** (`lib/debate/agents/advocate.ts`) — argues in favor of the PR changes
- **Critic agent** (`lib/debate/agents/critic.ts`) — finds issues and risks in the PR
- **Judge agent** (`lib/debate/agents/judge.ts`) — synthesizes debate into verdict
- **Types** (`lib/debate/types.ts`) — shared types including `DebateSession`, `DebateArgument`, `DebateRound`, `DebateConfig`, `DebateOutcome`, etc.

Recent merged PRs confirm these agents exist:
- `lib/debate/agents/judge.ts` — "implement judge agent — synthesizes debate into verdict"
- `lib/debate/agents/critic.ts` — "implement critic agent — finds issues and risks in PR"
- An advocate agent was also created (implied by the judge/critic pattern)

Your task is to implement `lib/debate/orchestrator.ts` — the coordinator that runs these agents through multiple rounds until consensus or max rounds is reached.

**No concurrent work overlaps with `lib/debate/orchestrator.ts`.** Concurrent work is on `lib/knowledge-graph/types.ts` — no coordination needed.

## Requirements

1. Export `async function runDebate(params: { diff: string, prDescription: string, codebaseContext: string, prNumber: number, repo: string, config?: DebateConfig }): Promise<DebateSession>`
2. Generate a unique session ID using `crypto.randomUUID()` (no extra dependencies)
3. Run advocate and critic **in parallel** via `Promise.all` for each round
4. After each round, the judge evaluates and determines whether to continue
5. Use a `shouldContinueDebate()` check (based on judge output) to decide whether to loop
6. For subsequent rounds (round > 1), pass previous round's critic arguments to the advocate and previous round's advocate arguments to the critic
7. Populate a `DebateSession` with all rounds, final outcome, start/end timestamps, and token usage
8. Export `formatDebateForComment(session: DebateSession): string` producing GitHub PR comment-ready markdown with:
   - Round-by-round summary of key arguments
   - Final verdict with reasoning
   - Token usage summary
   - Collapsible `<details>` section with full arguments
9. Respect `config.maxRounds` (default to type-defined default if not provided)
10. Handle errors gracefully — if an agent throws, surface the error in the session rather than crashing

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/implement-debate-orchestrator
```

### Step 1: Inspect existing types and agent signatures

Before writing any code, read the existing files to understand exact interfaces:

```bash
cat lib/debate/types.ts
cat lib/debate/agents/judge.ts
cat lib/debate/agents/critic.ts
cat lib/debate/agents/advocate.ts 2>/dev/null || echo "check for advocate file"
ls lib/debate/
```

Pay close attention to:
- The exact shape of `DebateSession`, `DebateRound`, `DebateArgument`, `DebateConfig`, `DebateOutcome`
- The function signatures exported from advocate, critic, and judge agents
- What fields are required vs optional
- How `shouldContinueDebate` might already be defined (in types.ts or judge.ts)
- Token usage fields in the types

### Step 2: Implement `lib/debate/orchestrator.ts`

Create `lib/debate/orchestrator.ts`. Below is a reference implementation — **adjust types and function call signatures to match what you found in Step 1**:

```typescript
import type {
  DebateSession,
  DebateRound,
  DebateArgument,
  DebateConfig,
  DebateOutcome,
} from './types';
// Import actual function names from the agents — adjust as needed
import { runAdvocate } from './agents/advocate';
import { runCritic } from './agents/critic';
import { runJudge } from './agents/judge';

const DEFAULT_MAX_ROUNDS = 3;

export interface RunDebateParams {
  diff: string;
  prDescription: string;
  codebaseContext: string;
  prNumber: number;
  repo: string;
  config?: DebateConfig;
}

export async function runDebate(params: RunDebateParams): Promise<DebateSession> {
  const {
    diff,
    prDescription,
    codebaseContext,
    prNumber,
    repo,
    config,
  } = params;

  const sessionId = crypto.randomUUID();
  const maxRounds = config?.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const startedAt = new Date().toISOString();

  const rounds: DebateRound[] = [];
  let totalTokens = 0;
  let outcome: DebateOutcome | undefined;

  let previousAdvocateArgument: DebateArgument | undefined;
  let previousCriticArgument: DebateArgument | undefined;

  for (let roundNumber = 1; roundNumber <= maxRounds; roundNumber++) {
    const roundStartedAt = new Date().toISOString();

    // Run advocate and critic in parallel
    const [advocateResult, criticResult] = await Promise.all([
      runAdvocate({
        diff,
        prDescription,
        codebaseContext,
        roundNumber,
        previousCriticArgument,
      }),
      runCritic({
        diff,
        prDescription,
        codebaseContext,
        roundNumber,
        previousAdvocateArgument,
      }),
    ]);

    const advocateArgument: DebateArgument = advocateResult;
    const criticArgument: DebateArgument = criticResult;

    // Judge evaluates this round
    const judgeResult = await runJudge({
      diff,
      prDescription,
      codebaseContext,
      rounds: [
        ...rounds,
        {
          roundNumber,
          advocateArgument,
          criticArgument,
          startedAt: roundStartedAt,
          completedAt: new Date().toISOString(),
        } as DebateRound,
      ],
      config,
    });

    const round: DebateRound = {
      roundNumber,
      advocateArgument,
      criticArgument,
      judgeEvaluation: judgeResult.evaluation,
      startedAt: roundStartedAt,
      completedAt: new Date().toISOString(),
    };

    rounds.push(round);

    // Accumulate token usage
    if (advocateResult.tokenUsage) totalTokens += advocateResult.tokenUsage.total ?? 0;
    if (criticResult.tokenUsage) totalTokens += criticResult.tokenUsage.total ?? 0;
    if (judgeResult.tokenUsage) totalTokens += judgeResult.tokenUsage.total ?? 0;

    // Check for consensus or end condition
    const shouldContinue = shouldContinueDebate(judgeResult, roundNumber, maxRounds);

    if (!shouldContinue) {
      outcome = judgeResult.outcome;
      break;
    }

    // Set context for next round
    previousAdvocateArgument = advocateArgument;
    previousCriticArgument = criticArgument;

    // If last round, capture outcome anyway
    if (roundNumber === maxRounds) {
      outcome = judgeResult.outcome;
    }
  }

  const completedAt = new Date().toISOString();

  const session: DebateSession = {
    sessionId,
    prNumber,
    repo,
    rounds,
    outcome: outcome!,
    config: config ?? { maxRounds: DEFAULT_MAX_ROUNDS },
    startedAt,
    completedAt,
    totalTokens,
  };

  return session;
}

function shouldContinueDebate(
  judgeResult: Awaited<ReturnType<typeof runJudge>>,
  currentRound: number,
  maxRounds: number,
): boolean {
  if (currentRound >= maxRounds) return false;
  // Continue if judge says no consensus yet
  return !judgeResult.outcome?.consensus;
}

export function formatDebateForComment(session: DebateSession): string {
  const { rounds, outcome, totalTokens, prNumber, repo, startedAt, completedAt } = session;

  const durationMs =
    new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const durationSec = (durationMs / 1000).toFixed(1);

  const lines: string[] = [];

  lines.push('## 🏛️ Debate Review');
  lines.push('');
  lines.push(
    `**${rounds.length} round${rounds.length !== 1 ? 's' : ''}** · **${repo}#${prNumber}** · ${durationSec}s`,
  );
  lines.push('');

  // Round summaries
  for (const round of rounds) {
    lines.push(`### Round ${round.roundNumber}`);
    lines.push('');
    lines.push(`**🟢 Advocate:** ${summarize(round.advocateArgument?.summary ?? round.advocateArgument?.content ?? '')}`);
    lines.push('');
    lines.push(`**🔴 Critic:** ${summarize(round.criticArgument?.summary ?? round.criticArgument?.content ?? '')}`);
    lines.push('');
    if (round.judgeEvaluation) {
      lines.push(`**⚖️ Judge:** ${summarize(round.judgeEvaluation?.summary ?? round.judgeEvaluation?.reasoning ?? '')}`);
      lines.push('');
    }
  }

  // Final verdict
  lines.push('---');
  lines.push('');
  lines.push('### 📋 Final Verdict');
  lines.push('');
  if (outcome) {
    const verdictEmoji = outcome.recommendation === 'approve' ? '✅' : outcome.recommendation === 'request_changes' ? '❌' : '💬';
    lines.push(`${verdictEmoji} **${outcome.recommendation?.toUpperCase() ?? 'REVIEW'}**`);
    lines.push('');
    if (outcome.reasoning) {
      lines.push(outcome.reasoning);
      lines.push('');
    }
    if (outcome.consensus !== undefined) {
      lines.push(`*Consensus reached: ${outcome.consensus ? 'Yes' : 'No'}*`);
      lines.push('');
    }
  }

  // Token usage summary
  lines.push('---');
  lines.push('');
  lines.push(`**Token usage:** ~${totalTokens.toLocaleString()} tokens across ${rounds.length} round${rounds.length !== 1 ? 's' : ''}`);
  lines.push('');

  // Collapsible full details
  lines.push('<details>');
  lines.push('<summary>📖 Full debate transcript</summary>');
  lines.push('');
  for (const round of rounds) {
    lines.push(`#### Round ${round.roundNumber} — Full Arguments`);
    lines.push('');
    lines.push('**Advocate:**');
    lines.push('');
    lines.push('```');
    lines.push(round.advocateArgument?.content ?? '(no content)');
    lines.push('```');
    lines.push('');
    lines.push('**Critic:**');
    lines.push('');
    lines.push('```');
    lines.push(round.criticArgument?.content ?? '(no content)');
    lines.push('```');
    lines.push('');
    if (round.judgeEvaluation) {
      lines.push('**Judge Evaluation:**');
      lines.push('');
      lines.push('```');
      lines.push(
        typeof round.judgeEvaluation === 'string'
          ? round.judgeEvaluation
          : JSON.stringify(round.judgeEvaluation, null, 2),
      );
      lines.push('```');
      lines.push('');
    }
  }
  lines.push('</details>');
  lines.push('');

  return lines.join('\n');
}

function summarize(text: string, maxChars = 200): string {
  if (!text) return '_(no summary)_';
  const cleaned = text.replace(/\n+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars - 1) + '…';
}
```

> **Important:** After reading the actual type definitions in Step 1, adjust:
> - Field names on `DebateArgument` (e.g., `content`, `summary`, `points`)
> - Field names on `DebateRound` (e.g., `judgeEvaluation` might be named differently)
> - Field names on `DebateOutcome` (e.g., `recommendation`, `consensus`, `reasoning`)
> - Field names on `DebateConfig` (e.g., `maxRounds`)
> - Function call signatures for `runAdvocate`, `runCritic`, `runJudge` — match what those files actually export
> - Token usage field paths (may be `usage.inputTokens + usage.outputTokens` or a flat `tokens` field)
> - `shouldContinueDebate` may already be exported from `types.ts` or `judge.ts` — if so, import and use it instead of defining locally

### Step 3: TypeScript check

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues to watch for:
- Missing required fields on `DebateSession` — add any required fields from the actual type
- `DebateRound` shape mismatch — match all required fields
- `runAdvocate`/`runCritic`/`runJudge` return type mismatches
- `crypto.randomUUID()` availability — if TypeScript complains, add `"lib": ["ES2021"]` or use `import { randomUUID } from 'crypto'` (Node.js built-in)

If `crypto.randomUUID` is not available in the TypeScript lib, use the Node.js crypto module:
```typescript
import { randomUUID } from 'crypto';
// then: const sessionId = randomUUID();
```

### Step 4: Build check

```bash
npm run build
```

Fix any build errors. The orchestrator should not import any external packages not already in `package.json`.

### Step 5: Verify the debate module structure

```bash
ls lib/debate/
# Expected: agents/, orchestrator.ts, types.ts (at minimum)
```

Confirm the file was created correctly:
```bash
head -5 lib/debate/orchestrator.ts
grep "export async function runDebate" lib/debate/orchestrator.ts
grep "export function formatDebateForComment" lib/debate/orchestrator.ts
```

### Step 6: Run tests (if any exist)

```bash
npm test -- --testPathPattern="debate" 2>/dev/null || echo "No debate tests found"
npm test 2>/dev/null || echo "No test suite configured"
```

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: implement debate orchestrator with multi-round loop and PR comment formatter"
git push origin feat/implement-debate-orchestrator
gh pr create \
  --title "feat: implement debate orchestrator — runs multi-round debate loop" \
  --body "## Summary

Implements \`lib/debate/orchestrator.ts\` — the coordinator for the multi-agent debate system.

## What's included

### \`runDebate(params)\`
- Generates a unique session ID via \`crypto.randomUUID()\`
- Runs advocate and critic agents **in parallel** via \`Promise.all\` each round
- Judge evaluates after each round
- Loops until judge reports consensus or \`maxRounds\` is reached
- Subsequent rounds pass previous round's arguments cross-wise (critic args → advocate, advocate args → critic)
- Returns a fully-populated \`DebateSession\` with all rounds, timestamps, and token totals

### \`formatDebateForComment(session)\`
- Produces GitHub PR comment-ready markdown
- Round-by-round summaries of advocate, critic, and judge
- Final verdict with recommendation and reasoning
- Token usage summary
- Collapsible \`<details>\` block with full transcript

## Acceptance criteria
- [x] Advocate and critic run in parallel (\`Promise.all\`) each round
- [x] Debate stops on consensus or \`maxRounds\`
- [x] Each round's arguments reference previous round context
- [x] \`DebateSession\` contains complete timeline with timestamps and token usage
- [x] \`formatDebateForComment\` produces valid markdown with round summaries, verdict, and collapsible details

## Related
- Builds on: critic agent, judge agent, debate types
- No files overlap with concurrent work item (knowledge-graph types)"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/implement-debate-orchestrator
FILES CHANGED: lib/debate/orchestrator.ts
SUMMARY: [what was done]
ISSUES: [what failed — e.g., type mismatch in DebateRound.judgeEvaluation field name, or runJudge signature incompatible]
NEXT STEPS: [e.g., "Reconcile judgeEvaluation field name with types.ts definition; adjust shouldContinueDebate logic to match JudgeResult shape"]
```

## Key Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Actual `DebateArgument` / `DebateRound` field names differ from assumptions | Step 1 reads all existing files before writing any code |
| `runAdvocate`/`runCritic`/`runJudge` have different signatures | Step 1 reads agent files; reference impl uses placeholders to adjust |
| `shouldContinueDebate` already defined elsewhere | Check types.ts and judge.ts; import if present rather than redefining |
| `crypto.randomUUID` TypeScript error | Fall back to `import { randomUUID } from 'crypto'` |
| Token usage field shape varies | Access defensively with optional chaining; sum whatever numeric fields exist |