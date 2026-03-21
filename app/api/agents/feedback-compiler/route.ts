import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export const revalidate = 300;

const GITHUB_REPO = "jamesstineheath/agent-forge";
const WORKFLOW_FILE = "tlm-feedback-compiler.yml";

export interface FeedbackCompilerData {
  status: "active" | "idle";
  lastRun: string | null;
  patternsDetected: number;
  changesProposed: number;
  lastRunDetails: {
    id: number;
    status: string;
    conclusion: string | null;
    createdAt: string;
    updatedAt: string;
    htmlUrl: string;
  } | null;
  source: "github-actions";
}

export async function GET(_req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = process.env.GH_PAT;
  if (!token) {
    return NextResponse.json(
      { error: "GH_PAT not configured" },
      { status: 500 }
    );
  }

  try {
    // Fetch the latest run of the feedback compiler workflow from GitHub Actions
    const runsUrl = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1`;
    const response = await fetch(runsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      next: { revalidate: 300 },
    });

    if (!response.ok) {
      if (response.status === 404) {
        const fallback: FeedbackCompilerData = {
          status: "idle",
          lastRun: null,
          patternsDetected: 0,
          changesProposed: 0,
          lastRunDetails: null,
          source: "github-actions",
        };
        return NextResponse.json(fallback);
      }
      return NextResponse.json(
        { error: `GitHub API error: ${response.status}` },
        { status: 502 }
      );
    }

    const data = await response.json();
    const latestRun = data.workflow_runs?.[0] ?? null;

    const lastRun = latestRun?.created_at ?? null;

    let status: "active" | "idle" = "idle";
    if (lastRun) {
      const daysSinceRun =
        (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60 * 24);
      status = daysSinceRun <= 8 ? "active" : "idle";
    }

    const result: FeedbackCompilerData = {
      status,
      lastRun,
      patternsDetected: 0,
      changesProposed: 0,
      lastRunDetails: latestRun
        ? {
            id: latestRun.id,
            status: latestRun.status,
            conclusion: latestRun.conclusion,
            createdAt: latestRun.created_at,
            updatedAt: latestRun.updated_at,
            htmlUrl: latestRun.html_url,
          }
        : null,
      source: "github-actions",
    };

    return NextResponse.json(result);
  } catch (error) {
    console.error("[feedback-compiler] Failed to fetch:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
