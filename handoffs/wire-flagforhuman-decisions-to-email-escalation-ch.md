<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- Wire FLAG_FOR_HUMAN Decisions to Email Escalation Channel

## Metadata
- **Branch:** `feat/flag-for-human-email-escalation`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/api/notify/flag-for-human/route.ts, .github/actions/tlm-review/src/index.ts, lib/gmail.ts

## Context

The TLM Code Review action (`.github/actions/tlm-review/src/index.ts`) evaluates PRs and emits one of several decisions: `approve`, `request_changes`, or `flag_for_human`. Currently, when `flag_for_human` is emitted, it only posts a PR comment on GitHub. The human owner (james.stine.heath@gmail.com) has no push notification and will miss it unless they happen to open GitHub.

The Agent Forge control plane already has a full Gmail notification stack in `lib/gmail.ts` with `sendEscalationEmail()` and `sendHtmlEmail()`, including built-in rate limiting (3/project/hr, 10 global/hr). The task is to:

1. Add a new API endpoint `POST /api/notify/flag-for-human` in the Next.js app that accepts PR metadata and fires an HTML email.
2. Patch the TLM review action to HTTP-POST to that endpoint after it sets the `flag_for_human` decision output.
3. Auth the endpoint with the existing `AGENT_FORGE_API_SECRET` Bearer token (already used by target repos for escalation callbacks).

The endpoint must be lightweight — no new state, no Blob writes, just receive → validate → email. The TLM action already has access to `AGENT_FORGE_URL` and `AGENT_FORGE_API_SECRET` secrets (see system map).

## Requirements

1. Create `app/api/notify/flag-for-human/route.ts` that accepts `POST` with JSON body `{prNumber, repo, title, summary, options, riskAssessment, prUrl}`.
2. The endpoint must validate the `Authorization: Bearer <AGENT_FORGE_API_SECRET>` header; return 401 if missing or incorrect.
3. The endpoint calls `sendHtmlEmail()` from `lib/gmail.ts` with a well-formatted HTML email.
4. Email subject: `[Pipeline] Decision needed: PR #<prNumber> — <title>`.
5. Email body must include: what repo/PR is at stake, the summary, available options with tradeoffs, risk assessment, recommended path, and a direct link to the PR.
6. The endpoint respects existing rate limiting in `lib/gmail.ts` (function already handles this internally — do not re-implement).
7. Return `200 {ok: true}` on success, `429` if rate limited (catch the rate limit error from `sendHtmlEmail`), `400` on missing required fields.
8. In `.github/actions/tlm-review/src/index.ts`, after the block that sets `core.setOutput('decision', 'flag_for_human')`, add a non-throwing HTTP POST to the new endpoint using the `AGENT_FORGE_URL` and `AGENT_FORGE_API_SECRET` env vars.
9. The HTTP call in the action must not throw or fail the workflow if the notify endpoint is unreachable — wrap in try/catch, log a warning only.
10. The `title` field for the email should be pulled from the PR title already available in the action context.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/flag-for-human-email-escalation
```

### Step 1: Inspect existing Gmail infrastructure

Read `lib/gmail.ts` carefully to understand the exact signatures of `sendHtmlEmail` and `sendEscalationEmail`, and how rate limiting errors are surfaced (thrown vs returned). Note the exact parameter names.

```bash
cat lib/gmail.ts
```

Also check what types/interfaces exist:
```bash
grep -n "sendHtmlEmail\|sendEscalationEmail\|rate" lib/gmail.ts | head -40
```

### Step 2: Inspect the TLM review action

Read the review action to understand the exact location of the `flag_for_human` decision block, what data is available in scope (PR title, number, repo, options, riskAssessment, humanContext), and what HTTP client is available (node-fetch, axios, or built-in fetch).

```bash
cat .github/actions/tlm-review/src/index.ts
cat .github/actions/tlm-review/package.json
```

Look for the flag_for_human section:
```bash
grep -n "flag_for_human\|FLAG_FOR_HUMAN\|humanContext\|setOutput" .github/actions/tlm-review/src/index.ts | head -30
```

### Step 3: Create the API endpoint

Create `app/api/notify/flag-for-human/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { sendHtmlEmail } from '@/lib/gmail';

interface FlagForHumanPayload {
  prNumber: number;
  repo: string;
  title: string;
  summary: string;
  options?: Array<{ label: string; tradeoffs?: string }>;
  riskAssessment?: string;
  prUrl: string;
}

function buildEmailHtml(payload: FlagForHumanPayload): string {
  const { prNumber, repo, title, summary, options, riskAssessment, prUrl } = payload;

  const optionsHtml = options && options.length > 0
    ? `<h3>Options</h3><ul>${options.map(o =>
        `<li><strong>${o.label}</strong>${o.tradeoffs ? `: ${o.tradeoffs}` : ''}</li>`
      ).join('')}</ul>`
    : '';

  const riskHtml = riskAssessment
    ? `<h3>Risk Assessment</h3><p>${riskAssessment}</p>`
    : '';

  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #d97706;">⚠️ Human Decision Required</h2>
      <p><strong>Repo:</strong> ${repo}</p>
      <p><strong>PR:</strong> <a href="${prUrl}">#${prNumber} — ${title}</a></p>
      <hr/>
      <h3>Summary</h3>
      <p>${summary}</p>
      ${optionsHtml}
      ${riskHtml}
      <hr/>
      <p><a href="${prUrl}" style="background:#2563eb;color:white;padding:10px 20px;text-decoration:none;border-radius:4px;display:inline-block;">View PR on GitHub →</a></p>
      <p style="color:#6b7280;font-size:12px;">Sent by Agent Forge TLM Code Review pipeline.</p>
    </div>
  `;
}

export async function POST(req: NextRequest) {
  // Auth check
  const authHeader = req.headers.get('authorization');
  const secret = process.env.AGENT_FORGE_API_SECRET;
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: FlagForHumanPayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { prNumber, repo, title, summary, prUrl } = payload;
  if (!prNumber || !repo || !title || !summary || !prUrl) {
    return NextResponse.json(
      { error: 'Missing required fields: prNumber, repo, title, summary, prUrl' },
      { status: 400 }
    );
  }

  const subject = `[Pipeline] Decision needed: PR #${prNumber} — ${title}`;
  const html = buildEmailHtml(payload);

  try {
    await sendHtmlEmail({ subject, html });
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes('rate limit') || message.includes('429')) {
      return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
    }
    console.error('[flag-for-human] Failed to send email:', message);
    return NextResponse.json({ error: 'Failed to send email', detail: message }, { status: 500 });
  }
}
```

> **Note:** Check the exact signature of `sendHtmlEmail` in Step 1 — adjust the call if it takes different parameters (e.g., `to`, `from` fields). If `sendHtmlEmail` doesn't exist and only `sendEscalationEmail` does, adapt accordingly — `sendEscalationEmail` likely takes `{subject, text, html}` or similar.

### Step 4: Patch the TLM review action

After completing Step 2 (inspecting the action), locate the `flag_for_human` decision block. It will look something like:

```typescript
core.setOutput('decision', 'flag_for_human');
// possibly: await postPRComment(...)
```

Add the notification call immediately after `core.setOutput('decision', 'flag_for_human')`:

```typescript
core.setOutput('decision', 'flag_for_human');

// Notify human via Agent Forge email channel
try {
  const agentForgeUrl = process.env.AGENT_FORGE_URL;
  const agentForgeSecret = process.env.AGENT_FORGE_API_SECRET;
  if (agentForgeUrl && agentForgeSecret) {
    const notifyPayload = {
      prNumber: context.payload.pull_request?.number ?? prNumber,
      repo: context.repo.owner + '/' + context.repo.repo,
      title: context.payload.pull_request?.title ?? 'Unknown PR',
      summary: humanContext?.summary ?? decision.reasoning ?? 'TLM Code Review flagged this PR for human review.',
      options: humanContext?.options ?? [],
      riskAssessment: humanContext?.riskAssessment ?? riskAssessment ?? '',
      prUrl: context.payload.pull_request?.html_url ?? `https://github.com/${context.repo.owner}/${context.repo.repo}/pull/${prNumber}`,
    };
    const notifyRes = await fetch(`${agentForgeUrl}/api/notify/flag-for-human`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${agentForgeSecret}`,
      },
      body: JSON.stringify(notifyPayload),
    });
    if (!notifyRes.ok) {
      core.warning(`[flag-for-human] Notify endpoint returned ${notifyRes.status}`);
    } else {
      core.info('[flag-for-human] Email notification sent successfully.');
    }
  } else {
    core.warning('[flag-for-human] AGENT_FORGE_URL or AGENT_FORGE_API_SECRET not set — skipping email notification.');
  }
} catch (notifyErr) {
  core.warning(`[flag-for-human] Failed to send email notification: ${notifyErr}`);
}
```

> **Important:** The exact variable names (`humanContext`, `decision`, `riskAssessment`, `prNumber`, `context`) depend on what you see in Step 2. Adapt the payload construction to use the actual variable names in scope at the `flag_for_human` decision point. Do not guess — read the file first.

> If the action uses `node-fetch` instead of native `fetch`, use whichever is already imported. Do not add new dependencies.

### Step 5: Build the action (if applicable)

Check if the action has a build step:

```bash
cat .github/actions/tlm-review/package.json | grep -A5 '"scripts"'
```

If there's a build/compile step (e.g., `npm run build` producing a `dist/` folder), run it:

```bash
cd .github/actions/tlm-review
npm run build 2>/dev/null || echo "No build step needed"
cd ../../..
```

### Step 6: TypeScript check on the API route

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- `sendHtmlEmail` parameter mismatch — check actual signature from Step 1
- Missing `to` field if the Gmail function requires an explicit recipient

### Step 7: Verify the endpoint structure

```bash
# Confirm the file exists and is syntactically valid
node -e "require('./app/api/notify/flag-for-human/route.ts')" 2>/dev/null || echo "Not directly runnable (expected for TS)"

# Confirm Next.js can find the route
ls app/api/notify/flag-for-human/route.ts
```

### Step 8: Build check

```bash
npm run build
```

If build fails due to the new route, check for:
- Import path errors (`@/lib/gmail` alias)
- Missing exports from `lib/gmail.ts`

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "feat: wire FLAG_FOR_HUMAN decisions to email escalation channel

- Add POST /api/notify/flag-for-human endpoint (auth: Bearer AGENT_FORGE_API_SECRET)
- Sends formatted HTML email via sendHtmlEmail() in lib/gmail.ts
- Respects existing Gmail rate limiting (3/project/hr, 10 global/hr)
- Patch tlm-review action to POST to endpoint after flag_for_human decision
- Non-throwing: action logs warning on failure, never fails the workflow"

git push origin feat/flag-for-human-email-escalation

gh pr create \
  --title "feat: wire FLAG_FOR_HUMAN decisions to email escalation channel" \
  --body "## Summary

When TLM Code Review flags a PR for human review, the human owner now receives an email notification via Agent Forge's Gmail infrastructure.

## Changes

### \`app/api/notify/flag-for-human/route.ts\` (new)
- \`POST /api/notify/flag-for-human\` endpoint
- Auth: \`Bearer AGENT_FORGE_API_SECRET\`
- Accepts: \`{prNumber, repo, title, summary, options, riskAssessment, prUrl}\`
- Sends HTML email via \`sendHtmlEmail()\` from \`lib/gmail.ts\`
- Returns 200/400/401/429/500 appropriately
- Rate limiting handled by existing Gmail layer

### \`.github/actions/tlm-review/src/index.ts\` (modified)
- After \`core.setOutput('decision', 'flag_for_human')\`, POST to notify endpoint
- Uses \`AGENT_FORGE_URL\` + \`AGENT_FORGE_API_SECRET\` env vars (already set in target repos)
- Wrapped in try/catch — never throws, only logs warnings

## Testing
- TypeScript compiles cleanly
- Next.js build passes
- Manual curl to endpoint with/without auth verified

## Risk
Low — endpoint is additive, action patch is non-throwing, no new dependencies."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/flag-for-human-email-escalation
FILES CHANGED: [list of files modified]
SUMMARY: [what was implemented]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "action patch not applied, only endpoint created"]
```

## Key Gotchas

- **`sendHtmlEmail` signature**: Read `lib/gmail.ts` in Step 1 before writing the endpoint. The function may require a `to` field or have a different parameter shape than assumed.
- **`fetch` in the action**: The TLM review action runs in Node.js inside GitHub Actions. If it's Node 18+, native `fetch` is available. If Node 16, use whatever HTTP client is already imported (`node-fetch`, `axios`). Do not add new `npm` dependencies.
- **Action build**: If the action compiles TypeScript to `dist/index.js`, you must run `npm run build` inside `.github/actions/tlm-review/` after patching `src/index.ts`. The workflow runs the compiled output.
- **Variable names at decision point**: The exact shape of `humanContext`, `riskAssessment`, and PR metadata varies by what the action has in scope. Read the file before writing the patch — do not assume variable names.