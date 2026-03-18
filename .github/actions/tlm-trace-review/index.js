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
