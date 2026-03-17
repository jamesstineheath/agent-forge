# Wire QA Agent Orchestration (run-qa.ts)

## Metadata
- **Complexity:** Complex
- **Risk:** Medium — new runtime behavior but advisory-only (never blocks merges)
- **Max Budget:** $8

## Context

The QA Agent (5th TLM agent) has all supporting modules shipped but `run-qa.ts` is a stub that does nothing. This handoff wires everything together.

**Existing modules (DO NOT rewrite — import and use them):**
- `.github/actions/tlm-qa-agent/src/smoke-test.ts` — exports `runSmokeTest(previewUrl, touchedRoutes, qaToken)`
- `.github/actions/tlm-qa-agent/src/parse-criteria.ts` — exports `parseAcceptanceCriteria(prBody)`, `extractFilePaths(prBody)`, `extractHandoffTitle(prBody)`
- `.github/actions/tlm-qa-agent/src/format-comment.ts` — exports `formatPRComment(report)`, `computeVerdict(results)`
- `.github/actions/tlm-qa-agent/system-prompt.md` — Claude system prompt for verification strategy
- `.github/actions/tlm-qa-agent/playwright.config.ts` — Playwright config (baseURL from PREVIEW_URL env)

**Architecture plan:** https://www.notion.so/325041760b7081e79b79ffcf6530dfaa
**Design decisions D1-D10 from that plan are constraints.**

## Step 0: Create branch, commit, push

```bash
git checkout -b fix/wire-qa-agent-orchestration
git add -A
git commit -m "feat: wire QA Agent orchestration — connect modules, add Claude + GitHub API"
git push -u origin fix/wire-qa-agent-orchestration
```

## Step 1: Add missing dependencies

In `.github/actions/tlm-qa-agent/package.json`, add:
- `@anthropic-ai/sdk` (latest) — for Claude API calls
- `@octokit/rest` (latest) — for GitHub API (fetch PR body, post comments)

Run `npm install` in that directory to generate/update the lockfile.

## Step 2: Replace run-qa.ts stub with orchestration logic

Replace `.github/actions/tlm-qa-agent/run-qa.ts` with full orchestration. The flow:

1. **Read environment variables:** `PREVIEW_URL`, `PR_NUMBER`, `REPO`, `ANTHROPIC_API_KEY`, `QA_BYPASS_SECRET`, `GITHUB_TOKEN`
2. **Validate inputs:** Exit cleanly (code 0) with a log message if PREVIEW_URL or PR_NUMBER is missing
3. **Fetch PR body** from GitHub API using Octokit: `GET /repos/{owner}/{repo}/pulls/{pr_number}`
4. **Parse acceptance criteria** via `parseAcceptanceCriteria(prBody)` from `./src/parse-criteria`
5. **Extract touched file paths** via `extractFilePaths(prBody)` — use these to derive touched API routes for smoke test
6. **Run smoke test** via `runSmokeTest(previewUrl, touchedRoutes, qaBypassSecret)` from `./src/smoke-test`
7. **If smoke test fails:** Skip Pass 2, set overall verdict to FAIL, include smoke failure details
8. **If smoke test passes, call Claude API** (single call per D6):
   - Read `system-prompt.md` from disk (use `fs.readFileSync` with `path.join(__dirname, 'system-prompt.md')`)
   - Send to Claude with: system prompt, PR diff (fetch via GitHub API), acceptance criteria list, preview URL
   - Ask Claude to classify each criterion as `http`, `playwright`, or `not-verifiable` and provide verification plan
   - Parse Claude's structured response to get per-criterion results
9. **For HTTP-verifiable criteria:** Make HTTP requests to the preview URL with `X-QA-Agent-Token` header, check responses
10. **For Playwright-verifiable criteria:** In v1, mark as SKIP with reason "Playwright dynamic test generation pending" (defer to future iteration — focus on getting HTTP checks working first)
11. **For not-verifiable criteria:** Mark as SKIP with Claude's explanation
12. **Compute verdict** via `computeVerdict(results)` from `./src/format-comment`
13. **Format PR comment** via `formatPRComment(report)` from `./src/format-comment`
14. **Post comment** to PR via Octokit: `POST /repos/{owner}/{repo}/issues/{pr_number}/comments`
15. **Exit 0** always (advisory mode — never fail the workflow)

**Important constraints:**
- Use `claude-opus-4-6` model (consistent with all TLM agents)
- Set max_tokens to 4096 for the Claude call
- Wrap the entire main flow in try/catch — on any error, log it and exit 0 (advisory mode)
- Include the `X-QA-Agent-Token` header (from QA_BYPASS_SECRET) on all HTTP requests to the preview URL
- The comment must include the `<!-- QA-AGENT-REPORT -->` HTML marker for deduplication (check if existing comment has this marker before posting a new one — update if exists)

## Step 3: Verify locally (pre-flight)

```bash
cd .github/actions/tlm-qa-agent
npx tsc --noEmit  # Type check
```

Ensure no TypeScript errors. The code should compile cleanly against the existing module type signatures.

## Pre-flight Self-check

Before committing, verify:
- [ ] `run-qa.ts` imports from `./src/smoke-test`, `./src/parse-criteria`, `./src/format-comment`
- [ ] `package.json` includes `@anthropic-ai/sdk` and `@octokit/rest`
- [ ] All environment variables are read from `process.env`
- [ ] Claude API call uses `claude-opus-4-6` model
- [ ] Entire main flow is wrapped in try/catch with exit 0 on error
- [ ] PR comment includes `<!-- QA-AGENT-REPORT -->` marker
- [ ] `X-QA-Agent-Token` header set on HTTP requests to preview URL
- [ ] TypeScript compiles without errors (`npx tsc --noEmit`)

## Session Abort Protocol

If blocked or over budget:
1. Commit whatever is working
2. Write a structured stdout summary:
```
QA_AGENT_STATUS: partial
COMPLETED: [list what's done]
REMAINING: [list what's left]
BLOCKER: [describe the issue]
```
3. Push and exit
