# Add QA Agent to Agents Dashboard

## Metadata
- **Complexity:** Simple
- **Risk:** Low — UI-only change, no backend logic
- **Max Budget:** $3

## Context

The QA Agent is the 5th TLM agent but is completely missing from the `/agents` dashboard page. The other four TLM agents (Code Reviewer, Spec Reviewer, Outcome Tracker, Feedback Compiler) all have `<TLMAgentCard>` components. The QA Agent needs one too.

The QA Agent workflow (`tlm-qa-agent.yml`) is deployed and active. Its `run-qa.ts` orchestration is being wired up separately (handoff #135). The dashboard card should be ready to display data once the agent starts writing to `docs/tlm-memory.md`.

## Step 0: Create branch, commit, push

```bash
git checkout -b fix/add-qa-agent-to-agents-dashboard
git add -A
git commit -m "feat: add QA Agent card to agents dashboard"
git push -u origin fix/add-qa-agent-to-agents-dashboard
```

## Step 1: Add QA Agent card to agents page

In `app/(app)/agents/page.tsx`, find the TLM Agents section where `<TLMAgentCard>` components are rendered for Code Reviewer, Spec Reviewer, Outcome Tracker, and Feedback Compiler.

Add a new `<TLMAgentCard>` for "QA Agent" with:
- **name:** "QA Agent"
- **status:** "active" (workflow is deployed)
- **description or subtitle:** "Post-deployment verification — advisory mode"
- Place it after Outcome Tracker and before Feedback Compiler (since Feedback Compiler is "in pipeline" and QA Agent is active)

## Step 2: Verify TLMAgentCard component compatibility

Read `components/tlm-agent-card.tsx` to check the component's props interface. The QA Agent's metrics differ from review agents:
- Instead of "correct/reversed/caused issues" review outcomes, QA Agent tracks: smoke test pass rate, criteria verified count, criteria skipped count, false positive/negative rates
- The existing card reads stats from TLM memory (`totalAssessed`, `correct`, `causedIssues`, etc.)

If the card component is flexible enough (e.g., shows "no data yet" when stats are missing), just add the card as-is. The QA Agent will start populating its memory section once run-qa.ts is wired up.

If the component requires specific stat fields, add graceful fallbacks (show "Awaiting first run" or similar when the QA Agent section doesn't exist in TLM memory yet).

## Step 3: Ensure TLM memory API handles QA Agent section

Check `app/api/agents/tlm-memory/route.ts`. It parses `docs/tlm-memory.md` by section headers. The QA Agent will write to a `## QA Agent` section. Verify the API can parse an additional section without breaking. If the parser is hardcoded to specific section names, add "QA Agent" to the list.

## Pre-flight Self-check

Before committing, verify:
- [ ] QA Agent card appears in the TLM Agents section of `app/(app)/agents/page.tsx`
- [ ] Card shows gracefully when no QA Agent data exists in TLM memory yet
- [ ] No TypeScript errors (`npx tsc --noEmit` or build check)
- [ ] Existing agent cards are unaffected

## Session Abort Protocol

If blocked or over budget:
1. Commit whatever is working
2. Write structured stdout summary:
```
QA_DASHBOARD_STATUS: partial
COMPLETED: [list what's done]
REMAINING: [list what's left]
BLOCKER: [describe the issue]
```
3. Push and exit
