import type {
  DebateSession,
  DebateRound,
  DebateConfig,
  DebateOutcome,
  DebateTokenUsage,
} from './types';
import { generateAdvocateArguments } from './agents/advocate';
import { generateCriticArguments } from './agents/critic';
import { evaluateDebate, shouldContinueDebate } from './agents/judge';
import { DEFAULT_DEBATE_CONFIG } from './config';
import { randomUUID } from 'crypto';

export interface RunDebateParams {
  diff: string;
  prDescription: string;
  codebaseContext: string;
  prNumber: number;
  repo: string;
  config?: DebateConfig;
}

export async function runDebate(params: RunDebateParams): Promise<DebateSession> {
  const { diff, prDescription, codebaseContext, prNumber, repo, config } = params;

  const effectiveConfig = config ?? DEFAULT_DEBATE_CONFIG;
  const sessionId = randomUUID();
  const startedAt = new Date().toISOString();

  const rounds: DebateRound[] = [];
  const tokenUsage: DebateTokenUsage = { advocate: 0, critic: 0, judge: 0, total: 0 };
  let outcome: DebateOutcome | null = null;
  let previousRound: DebateRound | undefined;

  for (let roundNumber = 1; roundNumber <= effectiveConfig.maxRounds; roundNumber++) {
    try {
      // Run advocate and critic in parallel
      const [advocateResult, criticResult] = await Promise.all([
        generateAdvocateArguments({
          diff,
          prDescription,
          codebaseContext,
          previousRound,
        }),
        generateCriticArguments({
          diff,
          prDescription,
          codebaseContext,
          previousRound,
        }),
      ]);

      const round: DebateRound = {
        roundNumber,
        arguments: [...advocateResult.arguments, ...criticResult.arguments],
        timestamp: new Date().toISOString(),
      };

      rounds.push(round);

      // Track token usage
      tokenUsage.advocate += advocateResult.usage.totalTokens;
      tokenUsage.critic += criticResult.usage.totalTokens;

      // Judge evaluates all rounds so far
      const judgeOutcome = await evaluateDebate({
        rounds,
        diff,
        prDescription,
        codebaseContext,
        config: effectiveConfig,
      });

      // Track judge tokens
      tokenUsage.judge += judgeOutcome.tokenUsage.judge;
      tokenUsage.total = tokenUsage.advocate + tokenUsage.critic + tokenUsage.judge;

      // Update outcome token usage with cumulative totals
      outcome = {
        ...judgeOutcome,
        tokenUsage: { ...tokenUsage },
      };

      // Check if debate should continue
      if (!shouldContinueDebate(judgeOutcome, effectiveConfig, roundNumber)) {
        break;
      }

      previousRound = round;
    } catch (error) {
      // Surface agent errors in the session rather than crashing
      const errorMessage = error instanceof Error ? error.message : String(error);
      outcome = {
        consensus: false,
        finalVerdict: 'escalate',
        reasoning: `Debate error in round ${roundNumber}: ${errorMessage}`,
        resolvedIssues: [],
        unresolvedDisagreements: [`Agent error: ${errorMessage}`],
        confidenceScore: 0,
        tokenUsage: { ...tokenUsage, total: tokenUsage.advocate + tokenUsage.critic + tokenUsage.judge },
      };
      break;
    }
  }

  return {
    id: sessionId,
    prNumber,
    repo,
    config: effectiveConfig,
    rounds,
    outcome,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

export function formatDebateForComment(session: DebateSession): string {
  const { rounds, outcome, prNumber, repo, startedAt, completedAt } = session;

  const durationMs = completedAt
    ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
    : 0;
  const durationSec = (durationMs / 1000).toFixed(1);

  const lines: string[] = [];

  lines.push('## 🏛️ Debate Review');
  lines.push('');
  lines.push(
    `**${rounds.length} round${rounds.length !== 1 ? 's' : ''}** · **${repo}#${prNumber}** · ${durationSec}s`
  );
  lines.push('');

  // Round summaries
  for (const round of rounds) {
    lines.push(`### Round ${round.roundNumber}`);
    lines.push('');

    const advocateArgs = round.arguments.filter((a) => a.position === 'advocate');
    const criticArgs = round.arguments.filter((a) => a.position === 'critic');

    if (advocateArgs.length > 0) {
      lines.push(`**🟢 Advocate:** ${summarize(advocateArgs.map((a) => a.claim).join('; '))}`);
      lines.push('');
    }

    if (criticArgs.length > 0) {
      lines.push(`**🔴 Critic:** ${summarize(criticArgs.map((a) => a.claim).join('; '))}`);
      lines.push('');
    }
  }

  // Final verdict
  lines.push('---');
  lines.push('');
  lines.push('### 📋 Final Verdict');
  lines.push('');
  if (outcome) {
    const verdictEmoji =
      outcome.finalVerdict === 'approve' ? '✅' : outcome.finalVerdict === 'request_changes' ? '❌' : '💬';
    lines.push(`${verdictEmoji} **${outcome.finalVerdict.toUpperCase()}**`);
    lines.push('');
    if (outcome.reasoning) {
      lines.push(outcome.reasoning);
      lines.push('');
    }
    lines.push(`*Consensus reached: ${outcome.consensus ? 'Yes' : 'No'}*`);
    lines.push('');
  }

  // Token usage summary
  lines.push('---');
  lines.push('');
  const totalTokens = outcome?.tokenUsage.total ?? 0;
  lines.push(
    `**Token usage:** ~${totalTokens.toLocaleString()} tokens across ${rounds.length} round${rounds.length !== 1 ? 's' : ''}`
  );
  lines.push('');

  // Collapsible full details
  lines.push('<details>');
  lines.push('<summary>📖 Full debate transcript</summary>');
  lines.push('');
  for (const round of rounds) {
    lines.push(`#### Round ${round.roundNumber} — Full Arguments`);
    lines.push('');

    const advocateArgs = round.arguments.filter((a) => a.position === 'advocate');
    const criticArgs = round.arguments.filter((a) => a.position === 'critic');

    lines.push('**Advocate:**');
    lines.push('');
    lines.push('```');
    if (advocateArgs.length > 0) {
      for (const arg of advocateArgs) {
        lines.push(`[${arg.confidence}] ${arg.claim}`);
        lines.push(`  Evidence: ${arg.evidence.join('; ')}`);
      }
    } else {
      lines.push('(no arguments)');
    }
    lines.push('```');
    lines.push('');

    lines.push('**Critic:**');
    lines.push('');
    lines.push('```');
    if (criticArgs.length > 0) {
      for (const arg of criticArgs) {
        lines.push(`[${arg.confidence}] ${arg.claim}`);
        lines.push(`  Evidence: ${arg.evidence.join('; ')}`);
      }
    } else {
      lines.push('(no arguments)');
    }
    lines.push('```');
    lines.push('');
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
