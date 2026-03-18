import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { DebateArgument, DebateRound } from "../types";

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

const AGENT_ID = "advocate-v1";

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
  "confidence": 0.85,
  "referencedFiles": ["path/to/file.ts"]
}

Rules:
- "position" must always be "advocate"
- "claim" must be a non-empty string
- "evidence" must be a non-empty array of strings with at least one item
- "confidence" must be a number between 0 and 1
- "referencedFiles" must be an array of file paths referenced in the argument (can be empty)
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
      (arg) => arg.position === "critic"
    );
    if (criticArguments.length > 0) {
      prompt += `\n## Critic Arguments to Rebut (Rebuttal Mode)
The critic raised the following concerns in the previous round. You must address each one:

${criticArguments
  .map(
    (arg, i) =>
      `### Critic Argument ${i + 1}
**Claim:** ${arg.claim}
**Evidence:** ${arg.evidence.join("; ")}
**Confidence:** ${arg.confidence}`
  )
  .join("\n\n")}

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
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
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
    throw new Error("Advocate agent response is not an array");
  }

  return parsed.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`Argument at index ${index} is not an object`);
    }
    const arg = item as Record<string, unknown>;

    if (arg.position !== "advocate") {
      throw new Error(
        `Argument at index ${index} has invalid position: ${arg.position}`
      );
    }
    if (typeof arg.claim !== "string" || arg.claim.trim() === "") {
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
      typeof arg.confidence !== "number" ||
      arg.confidence < 0 ||
      arg.confidence > 1
    ) {
      throw new Error(
        `Argument at index ${index} has invalid confidence: ${arg.confidence}`
      );
    }

    const referencedFiles = Array.isArray(arg.referencedFiles)
      ? (arg.referencedFiles as string[])
      : [];

    return {
      position: "advocate" as const,
      agentId: AGENT_ID,
      claim: arg.claim as string,
      evidence: arg.evidence as string[],
      confidence: arg.confidence as number,
      referencedFiles,
    };
  });
}

export async function generateAdvocateArguments(
  params: GenerateAdvocateArgumentsParams
): Promise<AdvocateResult> {
  const userPrompt = buildAdvocatePrompt(params);

  const result = await generateText({
    model: anthropic("claude-sonnet-4-6"),
    system: ADVOCATE_SYSTEM_PROMPT,
    prompt: userPrompt,
  });

  const debateArguments = parseDebateArguments(result.text);

  return {
    arguments: debateArguments,
    usage: {
      promptTokens: result.usage.inputTokens ?? 0,
      completionTokens: result.usage.outputTokens ?? 0,
      totalTokens:
        (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
    },
  };
}
