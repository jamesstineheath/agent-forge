import { NextResponse } from "next/server";
import { extractPageId } from "@/lib/decomposer";
import { fetchPageContent } from "@/lib/notion";
import { listRepos, getRepo } from "@/lib/repos";
import type { RepoConfig } from "@/lib/types";

/**
 * Temporary diagnostic endpoint to trace decomposer failures step by step.
 * DELETE THIS AFTER DEBUGGING.
 *
 * GET /api/debug/decomposer?planUrl=<url>&targetRepo=<repo>
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const planUrl = url.searchParams.get("planUrl");
  const targetRepo = url.searchParams.get("targetRepo") || "agent-forge";
  const primaryRepo = `jamesstineheath/${targetRepo}`;

  const steps: Record<string, unknown> = {};

  // Step 0: Check env vars
  steps["env_NOTION_API_KEY"] = process.env.NOTION_API_KEY ? `set (${process.env.NOTION_API_KEY.slice(0, 8)}...)` : "MISSING";
  steps["env_ANTHROPIC_API_KEY"] = process.env.ANTHROPIC_API_KEY ? `set (${process.env.ANTHROPIC_API_KEY.slice(0, 8)}...)` : "MISSING";
  steps["env_NOTION_PROJECTS_DB_ID"] = process.env.NOTION_PROJECTS_DB_ID || "MISSING";

  // Step 1: Extract page ID
  if (!planUrl) {
    steps["step1_extractPageId"] = "SKIPPED (no planUrl param provided)";
  } else {
    try {
      const pageId = extractPageId(planUrl);
      steps["step1_extractPageId"] = { success: true, pageId };

      // Step 2: Fetch page content
      try {
        const content = await fetchPageContent(pageId);
        steps["step2_fetchPageContent"] = {
          success: true,
          contentLength: content.length,
          trimmedLength: content.trim().length,
          passesMinLength: content.trim().length >= 50,
          preview: content.slice(0, 500),
        };
      } catch (err) {
        steps["step2_fetchPageContent"] = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack?.split("\n").slice(0, 5) : undefined,
        };
      }
    } catch (err) {
      steps["step1_extractPageId"] = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Step 3: Check repo index
  try {
    const repoIndex = await listRepos();
    steps["step3_repoIndex"] = {
      success: true,
      count: repoIndex.length,
      entries: repoIndex.map((e) => ({
        id: e.id,
        fullName: e.fullName,
        shortName: e.shortName,
      })),
    };

    // Step 4: Check primary repo match
    const matchingEntry = repoIndex.find((e) => e.fullName === primaryRepo);
    steps["step4_primaryRepoMatch"] = {
      primaryRepo,
      found: !!matchingEntry,
      matchedEntry: matchingEntry || null,
    };

    // Step 5: Load full config for matched repo
    if (matchingEntry) {
      try {
        const config = await getRepo(matchingEntry.id);
        steps["step5_repoConfig"] = {
          success: true,
          configExists: !!config,
          config: config ? {
            id: config.id,
            fullName: config.fullName,
            shortName: config.shortName,
            claudeMdPath: config.claudeMdPath,
            executeWorkflow: config.executeWorkflow,
            concurrencyLimit: config.concurrencyLimit,
          } : null,
        };
      } catch (err) {
        steps["step5_repoConfig"] = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  } catch (err) {
    steps["step3_repoIndex"] = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return NextResponse.json(steps, { status: 200 });
}
