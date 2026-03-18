import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type {
  DebateRound,
  DebateConfig,
  DebateOutcome,
  DebateTokenUsage,
} from "../types";

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
    .map((r) => {
      const advocateArgs = r.arguments
        .filter((a) => a.position === "advocate")
        .map(
          (a) =>
            `  - [confidence: ${a.confidence}] ${a.claim}\n    Evidence: ${a.evidence.join("; ")}`
        )
        .join("\n");

      const criticArgs = r.arguments
        .filter((a) => a.position === "critic")
        .map(
          (a) =>
            `  - [confidence: ${a.confidence}] ${a.claim}\n    Evidence: ${a.evidence.join("; ")}`
        )
        .join("\n");

      return `--- Round ${r.roundNumber} ---
Advocate arguments:
${advocateArgs || "  (none)"}

Critic arguments:
${criticArgs || "  (none)"}`;
    })
    .join("\n\n");

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

// ── Main export ────────────────────────────────────────────────────────────

export async function evaluateDebate(params: {
  rounds: DebateRound[];
  diff: string;
  prDescription: string;
  codebaseContext: string;
  config: DebateConfig;
}): Promise<DebateOutcome> {
  const { rounds, diff, prDescription, codebaseContext, config } = params;

  const model = config.model || "claude-sonnet-4-6";
  const userPrompt = buildJudgePrompt({
    rounds,
    diff,
    prDescription,
    codebaseContext,
  });

  const result = await generateText({
    model: anthropic(model),
    system: JUDGE_SYSTEM_PROMPT,
    prompt: userPrompt,
  });

  // Parse the JSON response
  let parsed: {
    finalVerdict: "approve" | "request_changes" | "escalate";
    reasoning: string;
    resolvedIssues: string[];
    unresolvedDisagreements: string[];
    consensus: boolean;
    confidenceScore: number;
  };

  try {
    const raw = result.text
      .trim()
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "");
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      finalVerdict: "escalate",
      reasoning: `Judge failed to parse LLM response: ${result.text.slice(0, 200)}`,
      resolvedIssues: [],
      unresolvedDisagreements: ["Unable to parse judge output"],
      consensus: false,
      confidenceScore: 0,
    };
  }

  // Validate finalVerdict
  const allowedVerdicts = [
    "approve",
    "request_changes",
    "escalate",
  ] as const;
  if (
    !allowedVerdicts.includes(
      parsed.finalVerdict as (typeof allowedVerdicts)[number]
    )
  ) {
    parsed.finalVerdict = "escalate";
  }

  // Aggregate token usage: judge call tokens
  const judgeTokens = (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);

  const tokenUsage: DebateTokenUsage = {
    advocate: 0,
    critic: 0,
    judge: judgeTokens,
    total: judgeTokens,
  };

  return {
    finalVerdict: parsed.finalVerdict,
    reasoning: parsed.reasoning ?? "",
    resolvedIssues: Array.isArray(parsed.resolvedIssues)
      ? parsed.resolvedIssues
      : [],
    unresolvedDisagreements: Array.isArray(parsed.unresolvedDisagreements)
      ? parsed.unresolvedDisagreements
      : [],
    consensus: Boolean(parsed.consensus),
    confidenceScore:
      typeof parsed.confidenceScore === "number"
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
  if (currentRound >= config.maxRounds) {
    return false;
  }

  if (outcome.consensus) {
    return false;
  }

  if (outcome.unresolvedDisagreements.length === 0) {
    return false;
  }

  return true;
}
