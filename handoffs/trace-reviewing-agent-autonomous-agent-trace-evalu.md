<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Trace Reviewing Agent

## Metadata
- **Branch:** `feat/tlm-trace-reviewer`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** `.github/workflows/tlm-trace-reviewer.yml`, `.github/actions/tlm-trace-review/action.yml`, `.github/actions/tlm-trace-review/index.js`, `docs/SYSTEM_MAP.md`

## Context

Agent Forge already has a TLM self-improvement loop (Outcome Tracker → TLM Memory → Feedback Compiler). This work item adds a **Trace Reviewing Agent** — an "agents reviewing agents" loop that evaluates decision quality, not just outcomes.

Existing TLM agents for reference pattern:
- **Feedback Compiler**: `.github/actions/tlm-feedback-compiler/` + `.github/workflows/tlm-feedback-compiler.yml` — weekly cron, reads `docs/tlm-memory.md`, uses Claude Opus, posts PRs with improvement proposals
- **Outcome Tracker**: `.github/actions/tlm-outcome-tracker/` + `.github/workflows/tlm-outcome-tracker.yml` — daily cron, assesses merged PR outcomes, writes to `docs/tlm-memory.md`

The agent traces live in Vercel Blob at `af-data/agent-traces/`. The structure is JSON files written by agents during their cron cycles. The Trace Reviewer will be a GitHub Actions workflow (not Vercel cron) because it needs longer runtime, Claude LLM reasoning, and daily (not 5-min) cadence.

The Trace Reviewer runs at **6am UTC daily** — before the Outcome Tracker at 9am — so findings are available when the outcome tracker runs.

This follows the exact same pattern as the Feedback Compiler: composite GitHub Action with a JS entrypoint, triggered by a workflow with daily schedule + `workflow_dispatch` for on-demand runs.

Environment variables available in GitHub Actions (already configured as repo secrets):
- `ANTHROPIC_API_KEY` — Claude API
- `AGENT_FORGE_API_SECRET` — Bearer token for Agent Forge API calls (filing work items, writing TLM memory)
- `AGENT_FORGE_URL` — Agent Forge base URL
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob access for reading traces

## Requirements

1. Workflow file at `.github/workflows/tlm-trace-reviewer.yml` runs daily at 6am UTC and supports `workflow_dispatch`
2. Composite action at `.github/actions/tlm-trace-review/` with `action.yml` + `index.js`
3. Action reads traces from Vercel Blob `af-data/agent-traces/` for the past 24 hours via the Blob list/get API
4. Action calls Claude Opus to analyze traces for: anomalies (>2x avg duration), decision quality, redundant work, error patterns (transient vs systemic), and model performance (when `model_used` field exists)
5. Action writes findings to `docs/tlm-memory.md` under a new "## Trace Review Findings" section (append-style, keep last 10 entries)
6. Action auto-files work items via `POST /api/work-items` (Bearer `AGENT_FORGE_API_SECRET`) for any finding with `severity >= high`
7. Action sends a weekly summary email via `POST /api/agents/trace-reviewer/notify` **OR** writes a structured findings JSON to Blob at `af-data/trace-review/latest.json` for consumption by other agents (implement the Blob write; email via existing Gmail infrastructure is future work)
8. When traces include `model_used` metadata, Claude analysis includes a model performance comparison section in findings
9. Action is idempotent — re-running for the same day appends with a dedup check on date in the findings section
10. `docs/SYSTEM_MAP.md` updated to include the new agent in the Data Plane table

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/tlm-trace-reviewer
```

### Step 1: Create the GitHub Actions workflow file

Create `.github/workflows/tlm-trace-reviewer.yml`:

```yaml
name: TLM Trace Reviewer

on:
  schedule:
    # Daily at 6am UTC — before Outcome Tracker (9am) so findings are available
    - cron: '0 6 * * *'
  workflow_dispatch:
    inputs:
      lookback_hours:
        description: 'Hours of traces to analyze (default: 24)'
        required: false
        default: '24'
      dry_run:
        description: 'Dry run — analyze but do not write findings or file work items'
        required: false
        default: 'false'

jobs:
  trace-review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Run Trace Reviewer
        uses: ./.github/actions/tlm-trace-review
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          agent_forge_api_secret: ${{ secrets.AGENT_FORGE_API_SECRET }}
          agent_forge_url: ${{ secrets.AGENT_FORGE_URL }}
          blob_read_write_token: ${{ secrets.BLOB_READ_WRITE_TOKEN }}
          lookback_hours: ${{ github.event.inputs.lookback_hours || '24' }}
          dry_run: ${{ github.event.inputs.dry_run || 'false' }}

      - name: Commit findings to TLM memory
        if: ${{ github.event.inputs.dry_run != 'true' }}
        run: |
          git config user.name "TLM Trace Reviewer"
          git config user.email "tlm-trace-reviewer@agent-forge"
          git add docs/tlm-memory.md
          git diff --staged --quiet || git commit -m "chore: trace review findings $(date -u +%Y-%m-%d)"
          git push origin main || echo "Nothing to push or push failed (non-fatal)"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Step 2: Create the action directory and action.yml

Create `.github/actions/tlm-trace-review/action.yml`:

```yaml
name: 'TLM Trace Reviewer'
description: 'Analyzes recent agent traces for anomalies, decision quality issues, and error patterns'

inputs:
  anthropic_api_key:
    description: 'Anthropic API key for Claude'
    required: true
  agent_forge_api_secret:
    description: 'Bearer token for Agent Forge API'
    required: true
  agent_forge_url:
    description: 'Agent Forge base URL'
    required: true
  blob_read_write_token:
    description: 'Vercel Blob read/write token'
    required: true
  lookback_hours:
    description: 'Hours of traces to look back (default: 24)'
    required: false
    default: '24'
  dry_run:
    description: 'If true, analyze but do not write findings or file work items'
    required: false
    default: 'false'

runs:
  using: 'node20'
  main: 'index.js'
```

### Step 3: Create the action entrypoint

Create `.github/actions/tlm-trace-review/index.js`:

```javascript
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Inputs ──────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.INPUT_ANTHROPIC_API_KEY;
const AGENT_FORGE_API_SECRET = process.env.INPUT_AGENT_FORGE_API_SECRET;
const AGENT_FORGE_URL = (process.env.INPUT_AGENT_FORGE_URL || '').replace(/\/$/, '');
const BLOB_READ_WRITE_TOKEN = process.env.INPUT_BLOB_READ_WRITE_TOKEN;
const LOOKBACK_HOURS = parseInt(process.env.INPUT_LOOKBACK_HOURS || '24', 10);
const DRY_RUN = process.env.INPUT_DRY_RUN === 'true';

// ── Constants ────────────────────────────────────────────────────────────────
const BLOB_API_BASE = 'https://blob.vercel-storage.com';
const TRACES_PREFIX = 'af-data/agent-traces/';
const FINDINGS_BLOB_KEY = 'af-data/trace-review/latest.json';
const TLM_MEMORY_PATH = path.join(process.cwd(), 'docs', 'tlm-memory.md');
const MAX_FINDINGS_SECTIONS = 10;

// ── Utilities ────────────────────────────────────────────────────────────────
function httpsRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── Blob Operations ──────────────────────────────────────────────────────────
async function listBlobsWithPrefix(prefix) {
  const url = `${BLOB_API_BASE}?prefix=${encodeURIComponent(prefix)}&limit=100`;
  try {
    const result = await httpsRequest(url, {
      headers: { Authorization: `Bearer ${BLOB_READ_WRITE_TOKEN}` },
    });
    return result.blobs || [];
  } catch (err) {
    console.warn(`Warning: could not list blobs with prefix ${prefix}: ${err.message}`);
    return [];
  }
}

async function getBlobContent(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function putBlobContent(key, content) {
  const url = `${BLOB_API_BASE}/${key}`;
  return httpsRequest(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${BLOB_READ_WRITE_TOKEN}`,
      'Content-Type': 'application/json',
    },
  }, JSON.stringify(content));
}

// ── Fetch Recent Traces ──────────────────────────────────────────────────────
async function fetchRecentTraces(lookbackHours) {
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
  const blobs = await listBlobsWithPrefix(TRACES_PREFIX);

  console.log(`Found ${blobs.length} trace blobs total`);

  const recentBlobs = blobs.filter((b) => {
    const uploadedAt = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
    return uploadedAt >= cutoff;
  });

  console.log(`${recentBlobs.length} blobs within last ${lookbackHours}h`);

  const traces = [];
  for (const blob of recentBlobs) {
    try {
      const content = await getBlobContent(blob.url);
      if (Array.isArray(content)) {
        traces.push(...content);
      } else if (content && typeof content === 'object') {
        traces.push(content);
      }
    } catch (err) {
      console.warn(`Could not read blob ${blob.pathname}: ${err.message}`);
    }
  }

  console.log(`Loaded ${traces.length} total trace entries`);
  return traces;
}

// ── Build Claude Analysis Prompt ─────────────────────────────────────────────
function buildAnalysisPrompt(traces, lookbackHours) {
  // Summarize traces to avoid massive token usage
  const agentGroups = {};
  for (const trace of traces) {
    const agent = trace.agent || trace.agentName || 'unknown';
    if (!agentGroups[agent]) agentGroups[agent] = [];
    agentGroups[agent].push(trace);
  }

  const summary = Object.entries(agentGroups).map(([agent, agentTraces]) => {
    const durations = agentTraces.map((t) => t.durationMs || t.duration_ms || 0).filter(Boolean);
    const avgDuration = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const errors = agentTraces.filter((t) => t.error || t.errorMessage || t.status === 'error');
    const phases = agentTraces.flatMap((t) => t.phases || t.steps || []);
    const modelUsed = agentTraces.map((t) => t.model_used || t.modelUsed).filter(Boolean);

    return {
      agent,
      traceCount: agentTraces.length,
      avgDurationMs: Math.round(avgDuration),
      maxDurationMs: durations.length ? Math.max(...durations) : 0,
      errorCount: errors.length,
      errorMessages: errors.slice(0, 3).map((t) => t.error || t.errorMessage || 'unknown error'),
      phaseCount: phases.length,
      modelsUsed: [...new Set(modelUsed)],
      recentStatuses: agentTraces.slice(-5).map((t) => t.status || t.outcome || 'unknown'),
      sampleTrace: agentTraces[0] || null,
    };
  });

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
async function analyzeWithClaude(prompt) {
  console.log('Calling Claude Opus for trace analysis...');
  const body = {
    model: 'claude-opus-4-5',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  };

  const result = await httpsRequest(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    },
    body
  );

  const text = result.content?.[0]?.text || '';
  try {
    // Strip any accidental markdown fencing
    const clean = text.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('Failed to parse Claude response as JSON:', text.slice(0, 500));
    throw new Error(`Claude returned non-JSON: ${err.message}`);
  }
}

// ── File Work Item ────────────────────────────────────────────────────────────
async function fileWorkItem(finding) {
  if (!AGENT_FORGE_URL) {
    console.warn('AGENT_FORGE_URL not set, skipping work item filing');
    return null;
  }

  const body = {
    title: finding.workItemTitle,
    description: `[Auto-filed by TLM Trace Reviewer]\n\n${finding.workItemDescription}\n\n**Finding ID:** ${finding.id}\n**Agent:** ${finding.agent}\n**Severity:** ${finding.severity}\n**Evidence:** ${finding.evidence}`,
    priority: finding.severity === 'critical' ? 'high' : 'medium',
    type: 'fix',
    source: 'trace-reviewer',
    repoFullName: 'jamesstineheath/agent-forge',
  };

  try {
    const result = await httpsRequest(
      `${AGENT_FORGE_URL}/api/work-items`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${AGENT_FORGE_API_SECRET}`,
          'Content-Type': 'application/json',
        },
      },
      body
    );
    console.log(`Filed work item: ${finding.workItemTitle} → ${result.id || 'ok'}`);
    return result;
  } catch (err) {
    console.warn(`Failed to file work item for ${finding.id}: ${err.message}`);
    return null;
  }
}

// ── Update TLM Memory ─────────────────────────────────────────────────────────
function updateTlmMemory(analysis, todayStr) {
  if (!fs.existsSync(TLM_MEMORY_PATH)) {
    console.warn('docs/tlm-memory.md not found, creating it');
    fs.mkdirSync(path.dirname(TLM_MEMORY_PATH), { recursive: true });
    fs.writeFileSync(TLM_MEMORY_PATH, '# TLM Memory\n\n');
  }

  let content = fs.readFileSync(TLM_MEMORY_PATH, 'utf8');

  // Dedup check: if today's entry already exists, skip
  if (content.includes(`### Trace Review — ${todayStr}`)) {
    console.log(`Trace review findings for ${todayStr} already present in TLM memory. Skipping.`);
    return false;
  }

  const findings = analysis.findings || [];
  const highSeverity = findings.filter((f) => f.severity === 'high' || f.severity === 'critical');

  const findingsText = findings.length === 0
    ? '- No significant findings.'
    : findings.map((f) =>
        `- **[${f.severity.toUpperCase()}]** \`${f.agent}\` — ${f.description} → _${f.recommendation}_`
      ).join('\n');

  const modelSection = analysis.modelPerformance?.available
    ? `\n**Model Performance:**\n${JSON.stringify(analysis.modelPerformance.comparison, null, 2)}`
    : '';

  const newEntry = `
### Trace Review — ${todayStr}
- **Window:** Last ${analysis.summary?.analysisWindowHours || 24}h
- **Traces analyzed:** ${analysis.summary?.totalTraces || 0}
- **Agents covered:** ${(analysis.summary?.agentsAnalyzed || []).join(', ') || 'unknown'}
- **Findings:** ${analysis.summary?.findingCount || 0} total, ${analysis.summary?.highSeverityCount || 0} high, ${analysis.summary?.criticalCount || 0} critical
- **Auto-filed work items:** ${highSeverity.filter((f) => f.autoFileWorkItem).length}

**Findings:**
${findingsText}${modelSection}
`;

  // Find or create the Trace Review Findings section
  const sectionHeader = '## Trace Review Findings';
  if (content.includes(sectionHeader)) {
    // Insert after the section header
    content = content.replace(
      sectionHeader,
      `${sectionHeader}\n${newEntry}`
    );
  } else {
    // Append new section at end
    content = content.trimEnd() + `\n\n${sectionHeader}\n${newEntry}`;
  }

  // Prune old entries: keep only the last MAX_FINDINGS_SECTIONS
  const sectionStart = content.indexOf(sectionHeader);
  if (sectionStart !== -1) {
    const beforeSection = content.slice(0, sectionStart + sectionHeader.length);
    const sectionBody = content.slice(sectionStart + sectionHeader.length);
    const entries = sectionBody.split(/(?=\n### Trace Review — )/);
    const prunedEntries = entries.slice(0, MAX_FINDINGS_SECTIONS + 1); // +1 for leading whitespace entry
    content = beforeSection + prunedEntries.join('');
  }

  fs.writeFileSync(TLM_MEMORY_PATH, content, 'utf8');
  console.log(`Updated docs/tlm-memory.md with trace review findings for ${todayStr}`);
  return true;
}

// ── Write Findings to Blob ────────────────────────────────────────────────────
async function writeFindingsToBlob(analysis, todayStr) {
  const payload = {
    date: todayStr,
    generatedAt: new Date().toISOString(),
    analysis,
  };
  try {
    await putBlobContent(FINDINGS_BLOB_KEY, payload);
    console.log(`Wrote findings to blob: ${FINDINGS_BLOB_KEY}`);
  } catch (err) {
    console.warn(`Failed to write findings to blob: ${err.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== TLM Trace Reviewer ===`);
  console.log(`Lookback: ${LOOKBACK_HOURS}h | Dry run: ${DRY_RUN}`);

  const todayStr = new Date().toISOString().slice(0, 10);

  // 1. Fetch recent traces
  let traces = [];
  try {
    traces = await fetchRecentTraces(LOOKBACK_HOURS);
  } catch (err) {
    console.error(`Failed to fetch traces: ${err.message}`);
    // Continue with empty traces — Claude will note the absence
  }

  // 2. Build prompt and analyze with Claude
  const prompt = buildAnalysisPrompt(traces, LOOKBACK_HOURS);
  let analysis;
  try {
    analysis = await analyzeWithClaude(prompt);
  } catch (err) {
    console.error(`Claude analysis failed: ${err.message}`);
    process.exit(1);
  }

  console.log(`Analysis complete: ${analysis.summary?.findingCount || 0} findings`);
  console.log(JSON.stringify(analysis.summary, null, 2));

  if (DRY_RUN) {
    console.log('DRY RUN — findings not persisted');
    console.log(JSON.stringify(analysis, null, 2));
    process.exit(0);
  }

  // 3. Update TLM memory
  updateTlmMemory(analysis, todayStr);

  // 4. Write findings to Blob (for downstream agents)
  await writeFindingsToBlob(analysis, todayStr);

  // 5. Auto-file work items for high/critical systemic issues
  const toFile = (analysis.findings || []).filter(
    (f) => f.autoFileWorkItem && (f.severity === 'high' || f.severity === 'critical')
  );
  console.log(`Auto-filing ${toFile.length} work items...`);
  for (const finding of toFile) {
    await fileWorkItem(finding);
  }

  console.log('=== Trace Reviewer complete ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

### Step 4: Update docs/SYSTEM_MAP.md

In the "Data Plane (per target repo)" table, find the existing TLM agents section and add the new agent. Find the line with `| Feedback Compiler | ...` and add after it:

```markdown
| TLM Trace Reviewer | `.github/actions/tlm-trace-review/` | Daily trace analysis, anomaly detection, auto-files work items for systemic issues |
```

Also add the workflow row to the workflows table (find `| Feedback Compiler | .github/workflows/tlm-feedback-compiler.yml |` and add):

```markdown
| Trace Reviewer | `.github/workflows/tlm-trace-reviewer.yml` | Daily 6am UTC trace analysis cron |
```

Use `sed` or direct file edit. Here is the sed approach for the action table row (run from repo root):

```bash
# Find the feedback compiler action row and append the trace reviewer row after it
sed -i 's/| Feedback Compiler | `.github\/actions\/tlm-feedback-compiler\/` | Weekly self-improvement proposals |/| Feedback Compiler | `.github\/actions\/tlm-feedback-compiler\/` | Weekly self-improvement proposals |\n| TLM Trace Reviewer | `.github\/actions\/tlm-trace-review\/` | Daily trace analysis, anomaly detection, auto-files work items for systemic issues |/' docs/SYSTEM_MAP.md
```

If sed fails due to line format differences, open the file and add the row manually in the correct table.

### Step 5: Verify the action file structure

```bash
# Confirm all files exist
ls -la .github/workflows/tlm-trace-reviewer.yml
ls -la .github/actions/tlm-trace-review/action.yml
ls -la .github/actions/tlm-trace-review/index.js

# Confirm Node.js syntax is valid
node --check .github/actions/tlm-trace-review/index.js

# Confirm docs updated
grep -n "Trace Reviewer\|tlm-trace-review" docs/SYSTEM_MAP.md
```

### Step 6: Verify TypeScript/build (repo-level checks)

```bash
# Verify repo still builds cleanly (this is a Next.js repo)
npx tsc --noEmit 2>&1 | head -30 || echo "TypeScript check done"

# Ensure no import breakage
npm run build 2>&1 | tail -20 || echo "Build check done"
```

The new files are pure GitHub Actions (JS + YAML) and don't touch the Next.js app, so build errors here would be pre-existing.

### Step 7: Commit, push, open PR

```bash
git add .github/workflows/tlm-trace-reviewer.yml
git add .github/actions/tlm-trace-review/action.yml
git add .github/actions/tlm-trace-review/index.js
git add docs/SYSTEM_MAP.md

git commit -m "feat: TLM Trace Reviewer — autonomous agent trace evaluation and improvement proposals

Adds a new TLM-style agent that reads recent agent traces from Vercel Blob
(af-data/agent-traces/) and produces structured findings using Claude Opus.

Findings cover:
- Anomalies (>2x avg duration, high error rates)
- Decision quality patterns per agent
- Redundant work / agent collisions
- Error patterns classified as systemic vs transient
- Model performance comparison (when model_used metadata exists)

Outputs:
- Appends findings to docs/tlm-memory.md (## Trace Review Findings section)
- Writes latest.json to af-data/trace-review/ blob for downstream agents
- Auto-files work items via /api/work-items for high/critical systemic findings

Runs daily at 6am UTC (before Outcome Tracker at 9am). Supports
workflow_dispatch with lookback_hours and dry_run inputs.

Part of the agents-reviewing-agents loop (complements Feedback Compiler).
Model routing integration ready: when model_used exists in traces, includes
per-model quality comparison in findings (closes PRJ-13 integration hook).

Acceptance criteria: all 10 requirements satisfied."

git push origin feat/tlm-trace-reviewer

gh pr create \
  --title "feat: TLM Trace Reviewer — autonomous agent trace evaluation and improvement proposals" \
  --body "## Summary

Adds the **TLM Trace Reviewer** — an autonomous agent that reads recent agent traces and produces actionable findings. This is the \"agents reviewing agents\" loop: the Supervisor monitors liveness, but the Trace Reviewer evaluates decision quality.

## What's New

### New Files
- \`.github/workflows/tlm-trace-reviewer.yml\` — Daily 6am UTC cron + \`workflow_dispatch\`
- \`.github/actions/tlm-trace-review/action.yml\` — Composite action definition
- \`.github/actions/tlm-trace-review/index.js\` — Node.js entrypoint (~280 lines)

### Updated Files
- \`docs/SYSTEM_MAP.md\` — Added TLM Trace Reviewer to Data Plane tables

## Architecture

Follows exact same pattern as Feedback Compiler (GitHub Actions, not Vercel cron):
- Reads Vercel Blob \`af-data/agent-traces/\` for last 24h of traces
- Calls Claude Opus for LLM-powered pattern analysis
- Writes findings to \`docs/tlm-memory.md\` (## Trace Review Findings section, last 10 entries)
- Writes \`af-data/trace-review/latest.json\` for downstream agent consumption
- Auto-files work items via \`POST /api/work-items\` for high/critical systemic findings

## Acceptance Criteria

- [x] Workflow runs daily at 6am UTC + workflow_dispatch support
- [x] Reads traces from \`af-data/agent-traces/\` blob prefix
- [x] Claude Opus analysis: anomalies, decision quality, redundant work, error patterns
- [x] Appends findings to \`docs/tlm-memory.md\` under new section (idempotent, dedup by date)
- [x] Auto-files work items for severity >= high systemic findings
- [x] Writes findings JSON to blob for downstream agents
- [x] When \`model_used\` exists in traces, includes model performance comparison
- [x] Supports dry_run mode (analyze without side effects)
- [x] SYSTEM_MAP.md updated

## Integration Hook (PRJ-13 Model Routing)

When model routing ships and adds \`model_used\` to work item traces, the Trace Reviewer automatically includes per-model quality comparison in its Claude analysis prompt and findings output. No code changes needed — the hook is already there.

## Testing

Run manually with dry_run:
\`\`\`
workflow_dispatch → dry_run: true → lookback_hours: 48
\`\`\`
" \
  --base main \
  --head feat/tlm-trace-reviewer
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
```bash
git add -A
git commit -m "feat: TLM Trace Reviewer (partial)"
git push origin feat/tlm-trace-reviewer
```
2. Open the PR with partial status:
```bash
gh pr create --title "feat: TLM Trace Reviewer (partial/WIP)" --body "Partial implementation — see ISSUES below." --base main --head feat/tlm-trace-reviewer
```
3. Output structured report:

```
STATUS: PR Open
PR: [URL from gh pr create output]
BRANCH: feat/tlm-trace-reviewer
FILES CHANGED:
  .github/workflows/tlm-trace-reviewer.yml
  .github/actions/tlm-trace-review/action.yml
  .github/actions/tlm-trace-review/index.js
  docs/SYSTEM_MAP.md
SUMMARY: Created TLM Trace Reviewer GitHub Action — reads agent traces from Vercel Blob, analyzes with Claude Opus, appends findings to TLM memory, auto-files work items for systemic issues
ISSUES: [describe what failed or was incomplete]
NEXT STEPS: [what remains — e.g., SYSTEM_MAP.md update, verify blob API format matches actual trace structure]
```