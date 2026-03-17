import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export const revalidate = 300;

export interface FeedbackCompilerData {
  status: "active" | "idle";
  lastRun: string | null;
  patternsDetected: number;
  changesProposed: number;
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
    const response = await fetch(
      "https://api.github.com/repos/jamesstineheath/personal-assistant/contents/docs/feedback-compiler-history.json",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3.raw",
        },
        next: { revalidate: 300 },
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        const fallback: FeedbackCompilerData = {
          status: "idle",
          lastRun: null,
          patternsDetected: 0,
          changesProposed: 0,
        };
        return NextResponse.json(fallback);
      }
      return NextResponse.json(
        { error: "Failed to fetch feedback compiler history" },
        { status: response.status }
      );
    }

    const history = (await response.json()) as {
      lastRun?: string;
      runs?: Array<{
        date?: string;
        patternsDetected?: number;
        changesProposed?: number;
      }>;
    };

    const lastRun = history.lastRun ?? null;
    const runs = history.runs ?? [];
    const mostRecent = runs[runs.length - 1] ?? null;

    let status: "active" | "idle" = "idle";
    if (lastRun) {
      const daysSinceRun =
        (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60 * 24);
      status = daysSinceRun <= 8 ? "active" : "idle";
    }

    const data: FeedbackCompilerData = {
      status,
      lastRun,
      patternsDetected: mostRecent?.patternsDetected ?? 0,
      changesProposed: mostRecent?.changesProposed ?? 0,
    };

    return NextResponse.json(data);
  } catch (error) {
    console.error("[feedback-compiler] Failed to fetch/parse:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
