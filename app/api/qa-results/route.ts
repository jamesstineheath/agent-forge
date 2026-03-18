import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { readFile } from "fs/promises";
import path from "path";

// Shape of a single ledger entry
interface LedgerEntry {
  agentType: string;
  timestamp: string;
  repo: string;
  outcome: "pass" | "fail";
  durationMs?: number;
  failureCategory?: string;
  summary?: string;
  prNumber?: number;
  [key: string]: unknown;
}

// Shape of the aggregated response
interface QAResultsResponse {
  passRate: number;
  totalRuns: number;
  failureCategories: { category: string; count: number }[];
  averageDurationMs: number;
  perRepo: { repo: string; passRate: number; totalRuns: number }[];
  recentRuns: {
    timestamp: string;
    repo: string;
    outcome: "pass" | "fail";
    durationMs?: number;
    failureCategory?: string;
    summary?: string;
    prNumber?: number;
  }[];
  graduationStatus: {
    currentRuns: number;
    requiredRuns: number;
    falseNegativeRate: number;
    graduated: boolean;
  };
}

const TARGET_REPOS = [
  "jamesstineheath/personal-assistant",
  "jamesstineheath/rez-sniper",
];

const LEDGER_PATH = "docs/tlm-action-ledger.json";

function emptyResponse(): QAResultsResponse {
  return {
    passRate: 0,
    totalRuns: 0,
    failureCategories: [],
    averageDurationMs: 0,
    perRepo: [],
    recentRuns: [],
    graduationStatus: {
      currentRuns: 0,
      requiredRuns: 20,
      falseNegativeRate: 0,
      graduated: false,
    },
  };
}

async function readLocalLedger(): Promise<LedgerEntry[]> {
  try {
    const filePath = path.join(process.cwd(), LEDGER_PATH);
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchRemoteLedger(
  repo: string,
  ghPat: string
): Promise<LedgerEntry[]> {
  try {
    const url = `https://api.github.com/repos/${repo}/contents/${LEDGER_PATH}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${ghPat}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "agent-forge",
      },
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    if (data.encoding === "base64" && data.content) {
      const decoded = Buffer.from(data.content, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);
      return Array.isArray(parsed) ? parsed : [];
    }
    return [];
  } catch {
    return [];
  }
}

function aggregateEntries(entries: LedgerEntry[]): QAResultsResponse {
  if (entries.length === 0) return emptyResponse();

  const totalRuns = entries.length;
  const passingRuns = entries.filter((e) => e.outcome === "pass").length;
  const passRate = totalRuns > 0 ? (passingRuns / totalRuns) * 100 : 0;

  // Average duration
  const entriesWithDuration = entries.filter(
    (e) => typeof e.durationMs === "number"
  );
  const averageDurationMs =
    entriesWithDuration.length > 0
      ? entriesWithDuration.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) /
        entriesWithDuration.length
      : 0;

  // Failure categories (only from failed runs)
  const failedEntries = entries.filter((e) => e.outcome === "fail");
  const categoryMap = new Map<string, number>();
  for (const entry of failedEntries) {
    const cat = entry.failureCategory ?? "unknown";
    categoryMap.set(cat, (categoryMap.get(cat) ?? 0) + 1);
  }
  const failureCategories = Array.from(categoryMap.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  // Per-repo breakdown
  const repoMap = new Map<string, { pass: number; total: number }>();
  for (const entry of entries) {
    const existing = repoMap.get(entry.repo) ?? { pass: 0, total: 0 };
    existing.total += 1;
    if (entry.outcome === "pass") existing.pass += 1;
    repoMap.set(entry.repo, existing);
  }
  const perRepo = Array.from(repoMap.entries()).map(([repo, { pass, total }]) => ({
    repo,
    passRate: total > 0 ? (pass / total) * 100 : 0,
    totalRuns: total,
  }));

  // Recent runs — sorted newest first, take last 10
  const recentRuns = [...entries]
    .sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    )
    .slice(0, 10)
    .map((e) => ({
      timestamp: e.timestamp,
      repo: e.repo,
      outcome: e.outcome,
      durationMs: e.durationMs,
      failureCategory: e.failureCategory,
      summary: e.summary,
      prNumber: e.prNumber,
    }));

  // Graduation status
  const falseNegatives = failedEntries.filter(
    (e) => e.failureCategory === "false_negative"
  ).length;
  const falseNegativeRate = totalRuns > 0 ? falseNegatives / totalRuns : 0;
  const REQUIRED_RUNS = 20;
  const graduated = totalRuns >= REQUIRED_RUNS && falseNegativeRate < 0.05;

  return {
    passRate,
    totalRuns,
    failureCategories,
    averageDurationMs,
    perRepo,
    recentRuns,
    graduationStatus: {
      currentRuns: totalRuns,
      requiredRuns: REQUIRED_RUNS,
      falseNegativeRate,
      graduated,
    },
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse ?days=N query param
  const { searchParams } = new URL(request.url);
  const daysParam = searchParams.get("days");
  const days = daysParam ? Math.max(1, parseInt(daysParam, 10)) : 30;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Gather all ledger entries
  const allEntries: LedgerEntry[] = [];

  // Local ledger
  const localEntries = await readLocalLedger();
  allEntries.push(...localEntries);

  // Remote ledger entries via GitHub API
  const ghPat = process.env.GH_PAT;
  if (ghPat) {
    const remoteResults = await Promise.allSettled(
      TARGET_REPOS.map((repo) => fetchRemoteLedger(repo, ghPat))
    );
    for (const result of remoteResults) {
      if (result.status === "fulfilled") {
        allEntries.push(...result.value);
      }
    }
  }

  // Filter: only qa-agent entries within the time window
  const filtered = allEntries.filter((entry) => {
    if (entry.agentType !== "qa-agent") return false;
    try {
      return new Date(entry.timestamp) >= cutoff;
    } catch {
      return false;
    }
  });

  const response = aggregateEntries(filtered);
  return NextResponse.json(response);
}
