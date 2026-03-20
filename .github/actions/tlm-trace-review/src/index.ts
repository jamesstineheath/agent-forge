import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import * as core from "@actions/core";

// ── Inputs ──────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.INPUT_ANTHROPIC_API_KEY;
const AGENT_FORGE_API_SECRET = process.env.INPUT_AGENT_FORGE_API_SECRET;
const AGENT_FORGE_URL = (process.env.INPUT_AGENT_FORGE_URL || "").replace(
  /\/$/,
  "",
);
const BLOB_READ_WRITE_TOKEN = process.env.INPUT_BLOB_READ_WRITE_TOKEN;
const LOOKBACK_HOURS = parseInt(
  process.env.INPUT_LOOKBACK_HOURS || "24",
  10,
);
const DRY_RUN = process.env.INPUT_DRY_RUN === "true";

// ── Constants ────────────────────────────────────────────────────────────────

const BLOB_API_BASE = "https://blob.vercel-storage.com";
const TRACES_PREFIX = "af-data/agent-traces/";
const FINDINGS_BLOB_KEY = "af-data/trace-review/latest.json";
const TLM_MEMORY_PATH = path.join(process.cwd(), "docs", "tlm-memory.md");
const MAX_FINDINGS_SECTIONS = 10;

// ── Types ────────────────────────────────────────────────────────────────────

interface BlobEntry {
  url: string;
  pathname: string;
  uploadedAt?: string;
}

interface TraceEntry {
  agent?: string;
  agentName?: string;
  durationMs?: number;
  duration_ms?: number;
  error?: string;
  errorMessage?: string;
  status?: string;
  outcome?: string;
  phases?: unknown[];
  steps?: unknown[];
  model_used?: string;
  modelUsed?: string;
}

interface Finding {
  id: string;
  agent: string;
  severity: "low" | "medium" | "high" | "critical";
  type: string;
  description: string;
  evidence: string;
  recommendation: string;
  autoFileWorkItem: boolean;
  workItemTitle: string | null;
  workItemDescription: string | null;
}

interface AnalysisSummary {
  totalTraces: number;
  agentsAnalyzed: string[];
  analysisWindowHours: number;
  findingCount: number;
  highSeverityCount: number;
  criticalCount: number;
}

interface ModelPerformance {
  available: boolean;
  comparison?: unknown[];
}

interface Analysis {
  summary?: AnalysisSummary;
  findings?: Finding[];
  modelPerformance?: ModelPerformance;
  decisionQualityScores?: Record<string, number | null>;
}

// ── Utilities ────────────────────────────────────────────────────────────────

function httpsRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
  body: string | object | null = null,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions: https.RequestOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };
    const req = https.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    if (body)
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

// ── Blob Operations ──────────────────────────────────────────────────────────

async function listBlobsWithPrefix(prefix: string): Promise<BlobEntry[]> {
  const url = `${BLOB_API_BASE}?prefix=${encodeURIComponent(prefix)}&limit=100`;
  try {
    const result = (await httpsRequest(url, {
      headers: { Authorization: `Bearer ${BLOB_READ_WRITE_TOKEN}` },
    })) as { blobs?: BlobEntry[] };
    return result.blobs || [];
  } catch (err) {
    console.warn(
      `Warning: could not list blobs with prefix ${prefix}: ${(err as Error).message}`,
    );
    return [];
  }
}

async function getBlobContent(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: "GET",
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => {
          data += c;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function putBlobContent(
  key: string,
  content: unknown,
): Promise<unknown> {
  const url = `${BLOB_API_BASE}/${key}`;
  return httpsRequest(
    url,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${BLOB_READ_WRITE_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
    JSON.stringify(content),
  );
}

// ── Fetch Recent Traces ──────────────────────────────────────────────────────

async function fetchRecentTraces(
  lookbackHours: number,
): Promise<TraceEntry[]> {
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
  const blobs = await listBlobsWithPrefix(TRACES_PREFIX);

  core.info(`Found ${blobs.length} trace blobs total`);

  const recentBlobs = blobs.filter((b) => {
    const uploadedAt = b.uploadedAt
      ? new Date(b.uploadedAt).getTime()
      : 0;
    return uploadedAt >= cutoff;
  });

  core.info(`${recentBlobs.length} blobs within last ${lookbackHours}h`);

  const traces: TraceEntry[] = [];
  for (const blob of recentBlobs) {
    try {
      const content = await getBlobContent(blob.url);
      if (Array.isArray(content)) {
        traces.push(...content);
      } else if (content && typeof content === "object") {
        traces.push(content as TraceEntry);
      }
    } catch (err) {
      console.warn(
        `Could not read blob ${blob.pathname}: ${(err as Error).message}`,
      );
    }
  }

  core.info(`Loaded ${traces.length} total trace entries`);
  return traces;
}

// ── Build Claude Analysis Prompt ─────────────────────────────────────────────

interface AgentSummary {
  agent: string;
  traceCount: number;
  avgDurationMs: number;
  maxDurationMs: number;
  errorCount: number;
  errorMessages: string[];
  phaseCount: number;
  modelsUsed: string[];
  recentStatuses: string[];
  sampleTrace: TraceEntry | null;
}

function buildAnalysisPrompt(
  traces: TraceEntry[],
  lookbackHours: number,
): string {
  const agentGroups: Record<string, TraceEntry[]> = {};
  for (const trace of traces) {
    const agent = trace.agent || trace.agentName || "unknown";
    if (!agentGroups[agent]) agentGroups[agent] = [];
    agentGroups[agent].push(trace);
  }

  const summary: AgentSummary[] = Object.entries(agentGroups).map(
    ([agent, agentTraces]) => {
      const durations = agentTraces
        .map((t) => t.durationMs || t.duration_ms || 0)
        .filter(Boolean);
      const avgDuration = durations.length
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0;
      const errors = agentTraces.filter(
        (t) => t.error || t.errorMessage || t.status === "error",
      );
      const phases = agentTraces.flatMap((t) => t.phases || t.steps || []);
      const modelUsed = agentTraces
        .map((t) => t.model_used || t.modelUsed)
        .filter(Boolean) as string[];

      return {
        agent,
        traceCount: agentTraces.length,
        avgDurationMs: Math.round(avgDuration),
        maxDurationMs: durations.length ? Math.max(...durations) : 0,
        errorCount: errors.length,
        errorMessages: errors
          .slice(0, 3)
          .map((t) => t.error || t.errorMessage || "unknown error"),
        phaseCount: phases.length,
        modelsUsed: [...new Set(modelUsed)],
        recentStatuses: agentTraces
          .slice(-5)
          .map((t) => t.status || t.outcome || "unknown"),
        sampleTrace: agentTraces[0] || null,
      };
    },
  );

  const hasModelData = traces.some((t) => t.model_used || t.modelUsed);

  return `You are the TLM Trace Reviewer for Agent Forge, an autonomous dev orchestration platform.

You are analyzing ${traces.length} agent traces from the last ${lookbackHours} hours.

## Agent Summary Data

${JSON.stringify(summary, null, 2)}

## Analysis Tasks

Analyze the above trace data and produce a structured findings report. For each finding:
- Identify the agent(s) involved
- Classify severity: low | medium | high | critical
- Classify type: anomaly | decision_quality | redundant_work | error_pattern | model_performance
- Provide a concise description (1-2 sentences)
- Provide a recommended action

### Specific checks to perform:

1. **Anomalies**: Flag any agent whose max duration is >2x their average duration. Flag agents with error rates >20%.

2. **Decision quality**: Look for patterns suggesting poor decisions:
   - Dispatcher: High error counts may indicate it's skipping work items incorrectly
   - Health Monitor: Error patterns may indicate missed stall detection
   - Project Manager: Long durations may indicate Claude timeout or loop

3. **Redundant work**: If multiple agents show similar error messages in the same time window, they may be colliding.

4. **Error patterns**: If the same error message appears in >2 cycles for the same agent, classify as "systemic" (needs_fix). If it appears once, classify as "transient".

5. **Model performance** (only if model data exists: ${hasModelData}): Compare outcomes/success rates between different models used. Flag cases where model selection appears suboptimal.

## Output Format

Return a JSON object with this exact structure:

\`\`\`json
{
  "summary": {
    "totalTraces": 0,
    "agentsAnalyzed": [],
    "analysisWindowHours": 24,
    "findingCount": 0,
    "highSeverityCount": 0,
    "criticalCount": 0
  },
  "findings": [
    {
      "id": "finding-001",
      "agent": "dispatcher|health-monitor|project-manager|supervisor|unknown",
      "severity": "low|medium|high|critical",
      "type": "anomaly|decision_quality|redundant_work|error_pattern|model_performance",
      "description": "Concise description of the finding",
      "evidence": "Specific data points supporting this finding",
      "recommendation": "Specific actionable recommendation",
      "autoFileWorkItem": true,
      "workItemTitle": "Title if autoFileWorkItem is true, else null",
      "workItemDescription": "Description if autoFileWorkItem is true, else null"
    }
  ],
  "modelPerformance": ${hasModelData ? `{
    "available": true,
    "comparison": []
  }` : '{"available": false}'},
  "decisionQualityScores": {
    "dispatcher": null,
    "healthMonitor": null,
    "projectManager": null,
    "supervisor": null
  }
}
\`\`\`

Set \`autoFileWorkItem: true\` only for findings with severity "high" or "critical" that represent systemic issues (not transient errors).

Return ONLY the JSON object, no markdown fencing.`;
}

// ── Call Claude ───────────────────────────────────────────────────────────────

async function analyzeWithClaude(prompt: string): Promise<Analysis> {
  core.info("Calling Claude Opus for trace analysis...");
  const body = {
    model: "claude-opus-4-5",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  };

  const result = (await httpsRequest(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    },
    body,
  )) as { content?: { text?: string }[] };

  const text = result.content?.[0]?.text || "";
  try {
    const clean = text
      .replace(/^```json\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    return JSON.parse(clean) as Analysis;
  } catch (err) {
    core.error(`Failed to parse Claude response as JSON: ${text.slice(0, 500)}`);
    throw new Error(`Claude returned non-JSON: ${(err as Error).message}`);
  }
}

// ── File Work Item ────────────────────────────────────────────────────────────

async function fileWorkItem(finding: Finding): Promise<unknown> {
  if (!AGENT_FORGE_URL) {
    console.warn("AGENT_FORGE_URL not set, skipping work item filing");
    return null;
  }

  const body = {
    title: finding.workItemTitle,
    description: `[Auto-filed by TLM Trace Reviewer]\n\n${finding.workItemDescription}\n\n**Finding ID:** ${finding.id}\n**Agent:** ${finding.agent}\n**Severity:** ${finding.severity}\n**Evidence:** ${finding.evidence}`,
    priority: finding.severity === "critical" ? "high" : "medium",
    type: "fix",
    source: "trace-reviewer",
    repoFullName: "jamesstineheath/agent-forge",
  };

  try {
    const result = (await httpsRequest(
      `${AGENT_FORGE_URL}/api/work-items`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AGENT_FORGE_API_SECRET}`,
          "Content-Type": "application/json",
        },
      },
      body,
    )) as { id?: string };
    core.info(
      `Filed work item: ${finding.workItemTitle} → ${result.id || "ok"}`,
    );
    return result;
  } catch (err) {
    console.warn(
      `Failed to file work item for ${finding.id}: ${(err as Error).message}`,
    );
    return null;
  }
}

// ── Update TLM Memory ────────────────────────────────────────────────────────

function updateTlmMemory(analysis: Analysis, todayStr: string): boolean {
  if (!fs.existsSync(TLM_MEMORY_PATH)) {
    console.warn("docs/tlm-memory.md not found, creating it");
    fs.mkdirSync(path.dirname(TLM_MEMORY_PATH), { recursive: true });
    fs.writeFileSync(TLM_MEMORY_PATH, "# TLM Memory\n\n");
  }

  let content = fs.readFileSync(TLM_MEMORY_PATH, "utf8");

  if (content.includes(`### Trace Review — ${todayStr}`)) {
    core.info(
      `Trace review findings for ${todayStr} already present in TLM memory. Skipping.`,
    );
    return false;
  }

  const findings = analysis.findings || [];
  const highSeverity = findings.filter(
    (f) => f.severity === "high" || f.severity === "critical",
  );

  const findingsText =
    findings.length === 0
      ? "- No significant findings."
      : findings
          .map(
            (f) =>
              `- **[${f.severity.toUpperCase()}]** \`${f.agent}\` — ${f.description} → _${f.recommendation}_`,
          )
          .join("\n");

  const modelSection = analysis.modelPerformance?.available
    ? `\n**Model Performance:**\n${JSON.stringify(analysis.modelPerformance.comparison, null, 2)}`
    : "";

  const newEntry = `
### Trace Review — ${todayStr}
- **Window:** Last ${analysis.summary?.analysisWindowHours || 24}h
- **Traces analyzed:** ${analysis.summary?.totalTraces || 0}
- **Agents covered:** ${(analysis.summary?.agentsAnalyzed || []).join(", ") || "unknown"}
- **Findings:** ${analysis.summary?.findingCount || 0} total, ${analysis.summary?.highSeverityCount || 0} high, ${analysis.summary?.criticalCount || 0} critical
- **Auto-filed work items:** ${highSeverity.filter((f) => f.autoFileWorkItem).length}

**Findings:**
${findingsText}${modelSection}
`;

  const sectionHeader = "## Trace Review Findings";
  if (content.includes(sectionHeader)) {
    content = content.replace(sectionHeader, `${sectionHeader}\n${newEntry}`);
  } else {
    content = content.trimEnd() + `\n\n${sectionHeader}\n${newEntry}`;
  }

  // Prune old entries: keep only the last MAX_FINDINGS_SECTIONS
  const sectionStart = content.indexOf(sectionHeader);
  if (sectionStart !== -1) {
    const beforeSection = content.slice(
      0,
      sectionStart + sectionHeader.length,
    );
    const sectionBody = content.slice(sectionStart + sectionHeader.length);
    const entries = sectionBody.split(/(?=\n### Trace Review — )/);
    const prunedEntries = entries.slice(0, MAX_FINDINGS_SECTIONS + 1);
    content = beforeSection + prunedEntries.join("");
  }

  fs.writeFileSync(TLM_MEMORY_PATH, content, "utf8");
  core.info(
    `Updated docs/tlm-memory.md with trace review findings for ${todayStr}`,
  );
  return true;
}

// ── Write Findings to Blob ──────────────────────────────────────────────────

async function writeFindingsToBlob(
  analysis: Analysis,
  todayStr: string,
): Promise<void> {
  const payload = {
    date: todayStr,
    generatedAt: new Date().toISOString(),
    analysis,
  };
  try {
    await putBlobContent(FINDINGS_BLOB_KEY, payload);
    core.info(`Wrote findings to blob: ${FINDINGS_BLOB_KEY}`);
  } catch (err) {
    console.warn(
      `Failed to write findings to blob: ${(err as Error).message}`,
    );
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  core.info(`=== TLM Trace Reviewer ===`);
  core.info(`Lookback: ${LOOKBACK_HOURS}h | Dry run: ${DRY_RUN}`);

  const todayStr = new Date().toISOString().slice(0, 10);

  // 1. Fetch recent traces
  let traces: TraceEntry[] = [];
  try {
    traces = await fetchRecentTraces(LOOKBACK_HOURS);
  } catch (err) {
    core.error(`Failed to fetch traces: ${(err as Error).message}`);
  }

  // 2. Build prompt and analyze with Claude
  const prompt = buildAnalysisPrompt(traces, LOOKBACK_HOURS);
  let analysis: Analysis;
  try {
    analysis = await analyzeWithClaude(prompt);
  } catch (err) {
    core.setFailed(`Claude analysis failed: ${(err as Error).message}`);
    return;
  }

  core.info(
    `Analysis complete: ${analysis.summary?.findingCount || 0} findings`,
  );
  core.info(JSON.stringify(analysis.summary, null, 2));

  if (DRY_RUN) {
    core.info("DRY RUN — findings not persisted");
    core.info(JSON.stringify(analysis, null, 2));
    return;
  }

  // 3. Update TLM memory
  updateTlmMemory(analysis, todayStr);

  // 4. Write findings to Blob (for downstream agents)
  await writeFindingsToBlob(analysis, todayStr);

  // 5. Auto-file work items for high/critical systemic issues
  const toFile = (analysis.findings || []).filter(
    (f) => f.autoFileWorkItem && (f.severity === "high" || f.severity === "critical"),
  );
  core.info(`Auto-filing ${toFile.length} work items...`);
  for (const finding of toFile) {
    await fileWorkItem(finding);
  }

  core.info("=== Trace Reviewer complete ===");
}

main().catch((err) => {
  core.setFailed(`Fatal error: ${err}`);
});
