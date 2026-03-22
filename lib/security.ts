/**
 * GitHub Security Alerts API client.
 * Fetches Dependabot, CodeQL, and secret scanning alerts for registered repos.
 */

const GITHUB_API = "https://api.github.com";

function headers(): HeadersInit {
  return {
    Authorization: `Bearer ${process.env.GH_PAT}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// --- Types ---

export type AlertSeverity = "critical" | "high" | "medium" | "low" | "warning" | "note" | "error";
export type AlertSource = "dependabot" | "code-scanning" | "secret-scanning";

export interface SecurityAlertSummary {
  repo: string;
  dependabot: SeverityCounts;
  codeScanning: SeverityCounts;
  secretScanning: { open: number };
  totalOpen: number;
  fetchedAt: string;
}

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface SecurityOverview {
  repos: SecurityAlertSummary[];
  totalAlerts: number;
  fetchedAt: string;
}

// --- Fetchers ---

async function fetchDependabotAlerts(repo: string): Promise<SeverityCounts> {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${repo}/dependabot/alerts?state=open&per_page=100`,
      { headers: headers() }
    );
    if (!res.ok) return counts;
    const alerts = (await res.json()) as Array<{
      security_vulnerability?: { severity: string };
      security_advisory?: { severity: string };
    }>;
    for (const alert of alerts) {
      const sev = (
        alert.security_vulnerability?.severity ??
        alert.security_advisory?.severity ??
        "low"
      ).toLowerCase();
      if (sev in counts) counts[sev as keyof SeverityCounts]++;
    }
  } catch (err) {
    console.warn(`[security] Failed to fetch Dependabot alerts for ${repo}:`, err);
  }
  return counts;
}

async function fetchCodeScanningAlerts(repo: string): Promise<SeverityCounts> {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${repo}/code-scanning/alerts?state=open&per_page=100`,
      { headers: headers() }
    );
    if (!res.ok) return counts;
    const alerts = (await res.json()) as Array<{
      rule?: { security_severity_level?: string; severity?: string };
    }>;
    for (const alert of alerts) {
      const raw = (
        alert.rule?.security_severity_level ??
        alert.rule?.severity ??
        "low"
      ).toLowerCase();
      // Map CodeQL severity names to our standard
      const sev = raw === "error" ? "high" : raw === "warning" ? "medium" : raw === "note" ? "low" : raw;
      if (sev in counts) counts[sev as keyof SeverityCounts]++;
    }
  } catch (err) {
    console.warn(`[security] Failed to fetch code scanning alerts for ${repo}:`, err);
  }
  return counts;
}

async function fetchSecretScanningAlerts(repo: string): Promise<{ open: number }> {
  try {
    const res = await fetch(
      `${GITHUB_API}/repos/${repo}/secret-scanning/alerts?state=open&per_page=100`,
      { headers: headers() }
    );
    if (!res.ok) return { open: 0 };
    const alerts = (await res.json()) as Array<unknown>;
    return { open: alerts.length };
  } catch (err) {
    console.warn(`[security] Failed to fetch secret scanning alerts for ${repo}:`, err);
    return { open: 0 };
  }
}

// --- Public API ---

export async function getSecurityAlerts(repo: string): Promise<SecurityAlertSummary> {
  const [dependabot, codeScanning, secretScanning] = await Promise.all([
    fetchDependabotAlerts(repo),
    fetchCodeScanningAlerts(repo),
    fetchSecretScanningAlerts(repo),
  ]);

  const totalOpen =
    dependabot.critical + dependabot.high + dependabot.medium + dependabot.low +
    codeScanning.critical + codeScanning.high + codeScanning.medium + codeScanning.low +
    secretScanning.open;

  return {
    repo,
    dependabot,
    codeScanning,
    secretScanning,
    totalOpen,
    fetchedAt: new Date().toISOString(),
  };
}

export async function getSecurityOverview(repos: string[]): Promise<SecurityOverview> {
  const summaries = await Promise.all(repos.map(getSecurityAlerts));
  return {
    repos: summaries,
    totalAlerts: summaries.reduce((sum, s) => sum + s.totalOpen, 0),
    fetchedAt: new Date().toISOString(),
  };
}
