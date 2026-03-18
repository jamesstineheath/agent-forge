import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { DebateArgument, DebateRound } from "../types";

export interface GenerateCriticArgumentsParams {
  diff: string;
  prDescription: string;
  codebaseContext: string;
  previousRound?: DebateRound;
}

export interface CriticResult {
  arguments: DebateArgument[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

const AGENT_ID = "critic-v1";

/**
 * Severity ordering for sorting critic arguments.
 * Lower number = higher priority.
 */
const SEVERITY_ORDER: Record<string, number> = {
  security: 0,
  correctness: 1,
  performance: 2,
  style: 3,
};

const CRITIC_SYSTEM_PROMPT = `You are a critic agent in a structured code review debate system.
Your role is to find real problems, weaknesses, and risks in a pull request.

Analyze the PR diff and codebase context, then identify issues. Focus on:
- **Security**: Authentication bypasses, injection vulnerabilities, exposed secrets, insecure data handling
- **Correctness**: Bugs, edge cases, off-by-one errors, null/undefined handling, race conditions
- **Performance**: Unnecessary re-renders, N+1 queries, missing memoization, expensive operations in hot paths
- **Style**: Convention violations, missing documentation, inconsistent naming, dead code

When responding in rebuttal mode (advocate arguments provided), you must directly address each advocate
claim, explaining why it is insufficient, overstated, or misses important risks.

Respond ONLY with a JSON array of debate arguments. Each argument must follow this exact schema:
{
  "position": "critic",
  "claim": "A clear, specific statement about a problem or risk",
  "evidence": ["specific evidence item 1", "specific evidence item 2"],
  "confidence": 0.85,
  "referencedFiles": ["path/to/file.ts"],
  "category": "security"
}

Rules:
- "position" must always be "critic"
- "claim" must be a non-empty string
- "evidence" must be a non-empty array of strings with at least one item
- "confidence" must be a number between 0 and 1
- "referencedFiles" must be an array of file paths referenced in the argument (can be empty)
- "category" must be one of: "security", "correctness", "performance", "style"
- Return a JSON array with 2-5 arguments, ordered by severity (security > correctness > performance > style)
- Do not wrap in markdown code fences or add any text outside the JSON array`;

export function buildCriticPrompt(params: {
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
    const advocateArguments = previousRound.arguments.filter(
      (arg) => arg.position === "advocate"
    );
    if (advocateArguments.length > 0) {
      prompt += `\n## Advocate Arguments to Rebut (Counter-Rebuttal Mode)
The advocate has made the following claims in favor of this PR. You must directly address and rebut these arguments:

${advocateArguments
  .map(
    (arg, i) =>
      `### Advocate Argument ${i + 1}
**Claim:** ${arg.claim}
**Evidence:** ${arg.evidence.join("; ")}
**Confidence:** ${arg.confidence}`
  )
  .join("\n\n")}

In counter-rebuttal mode, your arguments should specifically address why the advocate's claims are insufficient, overstated, or miss important risks.
`;
    }
  }

  prompt += `\nGenerate your critic arguments as a JSON array:`;

  return prompt;
}

function parseCriticArguments(rawText: string): {
  arguments: DebateArgument[];
  categories: Map<DebateArgument, string>;
} {
  // Strip markdown code fences if Claude wraps output despite instructions
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Attempt to extract JSON array from the text
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) {
      console.error(
        "[critic] Failed to parse response as JSON:",
        rawText.slice(0, 200)
      );
      return { arguments: [], categories: new Map() };
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      console.error("[critic] Failed to extract JSON array from response");
      return { arguments: [], categories: new Map() };
    }
  }

  if (!Array.isArray(parsed)) {
    console.error("[critic] Response is not an array");
    return { arguments: [], categories: new Map() };
  }

  const args: DebateArgument[] = [];
  const categories = new Map<DebateArgument, string>();

  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;

    const claim =
      typeof raw.claim === "string" ? raw.claim.trim() : "";
    if (!claim) {
      console.warn("[critic] Skipping argument with empty claim");
      continue;
    }

    const evidence = Array.isArray(raw.evidence)
      ? (raw.evidence as unknown[]).filter(
          (e): e is string => typeof e === "string" && e.trim().length > 0
        )
      : [];
    if (evidence.length === 0) {
      console.warn("[critic] Skipping argument with empty evidence:", claim);
      continue;
    }

    const confidence =
      typeof raw.confidence === "number"
        ? Math.max(0, Math.min(1, raw.confidence))
        : 0.5;

    const referencedFiles = Array.isArray(raw.referencedFiles)
      ? (raw.referencedFiles as string[])
      : [];

    const category =
      typeof raw.category === "string" ? raw.category : "style";

    const debateArg: DebateArgument = {
      position: "critic" as const,
      agentId: AGENT_ID,
      claim,
      evidence,
      confidence,
      referencedFiles,
    };

    args.push(debateArg);
    categories.set(debateArg, category);
  }

  return { arguments: args, categories };
}

function sortBySeverity(
  args: DebateArgument[],
  categories: Map<DebateArgument, string>
): DebateArgument[] {
  return [...args].sort((a, b) => {
    const catA = categories.get(a) ?? "style";
    const catB = categories.get(b) ?? "style";
    const orderA = SEVERITY_ORDER[catA] ?? 99;
    const orderB = SEVERITY_ORDER[catB] ?? 99;
    return orderA - orderB;
  });
}

export async function generateCriticArguments(
  params: GenerateCriticArgumentsParams
): Promise<CriticResult> {
  const userPrompt = buildCriticPrompt(params);

  console.log("[critic] Generating critic arguments...");

  const result = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system: CRITIC_SYSTEM_PROMPT,
    prompt: userPrompt,
  });

  // Log token usage
  console.log("[critic] Token usage:", {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  });

  const { arguments: rawArguments, categories } = parseCriticArguments(
    result.text
  );
  const sorted = sortBySeverity(rawArguments, categories);

  console.log(`[critic] Generated ${sorted.length} critic arguments`);

  return {
    arguments: sorted,
    usage: {
      promptTokens: result.usage.inputTokens ?? 0,
      completionTokens: result.usage.outputTokens ?? 0,
      totalTokens:
        (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
    },
  };
}
