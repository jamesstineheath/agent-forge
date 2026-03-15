# Agent Forge -- Handoff Lifecycle Orchestrator

## Metadata
- **Branch:** `feat/handoff-lifecycle-orchestrator`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $7
- **Risk Level:** low
- **Estimated files:** .github/workflows/handoff-orchestrator.yml, .github/actions/handoff-orchestrator/action.yml, .github/actions/handoff-orchestrator/src/index.ts, .github/actions/handoff-orchestrator/src/state.ts, .github/actions/handoff-orchestrator/package.json, .github/actions/handoff-orchestrator/tsconfig.json

## Context

The pipeline currently chains workflows via GitHub's `workflow_run` event and `check_suite` triggers. Each workflow (Spec Review, Execute Handoff, Code Review) is fire-and-forget: it does its job and exits with no persistent view of the handoff's overall lifecycle. This means:

- No single place tracks "handoff X is at step Y"
- CI failures between steps are invisible (addressed tactically by H17)
- Retries require manual intervention
- There's no way to query "what happened to handoff X end-to-end?"

This handoff introduces a **Handoff Lifecycle Orchestrator**: a lightweight state machine that tracks each handoff through its lifecycle and can trigger retries when failures occur. It does not replace the existing workflows. Instead, it observes their outputs and maintains state, acting as the "control plane" that the pipeline currently lacks.

### Architecture decision

The orchestrator is implemented as a GitHub Actions workflow + composite action, not as an ATC feature. Rationale:
- The pipeline runs in GitHub Actions. State transitions happen there.
- ATC runs in the Agent Forge Vercel deployment. Cross-system state sync adds complexity with no benefit at this scale.
- GitHub Actions has native access to workflow run status, check suites, and PR state.
- State is persisted as a JSON artifact on the orchestrator's own workflow run, with a summary posted as a PR comment for visibility.

When the ATC-driven Project Autopilot dispatches work items to the pipeline, the orchestrator's state becomes queryable via the GitHub API. A future integration (not in scope here) could have the ATC poll orchestrator state to detect stuck items.

### State machine

Each handoff transitions through these states:

```
SpecReview -> SpecReviewComplete -> Executing -> ExecutionComplete ->
  CIRunning -> CIPassed -> CodeReview -> CodeReviewComplete ->
  Merged | Failed | NeedsHumanReview
```

Failure transitions:
- `Executing -> ExecutionFailed` (Claude Code crashed or budget exceeded)
- `CIRunning -> CIFailed -> RetryingExecution` (CI failed, retry with error context)
- `RetryingExecution -> Executing` (retry attempt, max 1 retry)
- `RetryingExecution -> Failed` (retry also failed)
- `CodeReview -> RequestedChanges -> Failed` (Code Review rejected, no auto-fix)

### Existing patterns

**Workflow run events**: GitHub emits `workflow_run` events when workflows complete. The orchestrator triggers on these events for the relevant workflows.

**Check suite events**: `check_suite.completed` fires when CI finishes. The orchestrator can also trigger on this.

**PR state**: `pull_request` events track merges, closures, and review states.

**Handoff metadata**: Handoff files contain a `## Metadata` section with branch, priority, model, budget, and risk level. The orchestrator parses this for context.

**TLM Code Review metadata**: The Code Review action posts a `<!-- TLM-CODE-REVIEW-METADATA ... -->` comment with decision, auto_merge_safe, and issue counts. The orchestrator parses this.

**Execution cost metadata**: Execute Handoff posts a `### Execution Cost` comment with budget, actual cost, and token usage. The orchestrator parses this.

**Important**: Read the actual workflow files and action source in this repo at execution time. The exact structure may differ from what's described here. Use the descriptions to locate the right patterns.

### Retry design

When CI fails after execution, the orchestrator triggers a retry by:
1. Fetching the CI failure logs from the failed check run
2. Fetching the original handoff file from the branch
3. Creating a new prompt that includes both the original handoff context and the CI failure logs
4. Re-running `execute-handoff.yml` via `workflow_dispatch` with the same branch, appending " (retry: fix CI)" to the execution prompt
5. Maximum 1 automatic retry per handoff. If the retry also fails CI, transition to `Failed` and post a summary comment.

This retry mechanism is the core value: it closes the loop that H17 (CI Feedback Loop) opens. H17 makes CI failures visible. This handoff makes them actionable.

### Dependency on H17

This handoff assumes H17 (CI Feedback Loop) has been merged. Specifically:
- Execute Handoff exits with failure when CI fails (H17, Requirement 1)
- TLM Code Review defers approval when CI is failing (H17, Requirement 2)

If H17 has not been merged, the orchestrator can still track state, but the retry mechanism will not trigger correctly because Execute Handoff won't fail on CI failure.

## Requirements

1. **Create the orchestrator workflow** at `.github/workflows/handoff-orchestrator.yml`:
   - Triggers on `workflow_run` for: "TLM Spec Review", "Execute Handoff", "TLM Code Review", "CI"
   - Triggers on `pull_request` events: `closed` (to detect merges)
   - Also supports `workflow_dispatch` for manual state inspection
   - Uses per-branch concurrency to avoid race conditions on the same handoff
   - Calls the composite action with the event context

2. **Create the orchestrator action** at `.github/actions/handoff-orchestrator/`:
   - TypeScript action (same pattern as `tlm-review`)
   - `action.yml` defines inputs: `github-token`, `anthropic-api-key` (for retry prompt generation)
   - `src/state.ts` defines the state machine types and transition logic
   - `src/index.ts` handles event routing, state transitions, retry triggering, and comment posting

3. **State persistence**: Use GitHub Actions artifacts to persist state per branch. Each orchestrator run:
   - Downloads the latest state artifact for this branch (if exists)
   - Applies the state transition based on the triggering event
   - Uploads the updated state as a new artifact
   - Posts/updates a "Handoff Lifecycle" comment on the PR with a visual state diagram

4. **State tracking comment**: The orchestrator posts a single comment on the PR (identified by a `<!-- HANDOFF-LIFECYCLE-STATE -->` marker) that it updates on each transition. Format:
   ```
   ## Handoff Lifecycle

   **Current state:** CIPassed
   **Retries:** 0/1

   | Step | Status | Duration | Details |
   |------|--------|----------|---------|
   | Spec Review | Passed | 2m | Improved: yes |
   | Execution | Complete | 8m | Cost: $2.14 |
   | CI | Passed | 3m | Build + test |
   | Code Review | Pending | - | Waiting... |
   | Merge | Pending | - | - |
   ```

5. **Retry trigger**: When the orchestrator detects `CIFailed` state:
   - Check if retries < 1
   - Fetch CI logs from the failed check run via `checks.listForRef` and `checks.get`
   - Call `workflow_dispatch` on `execute-handoff.yml` with the same branch and handoff file
   - The execute-handoff prompt should include the CI failure context so Claude Code can fix the issue
   - Transition to `RetryingExecution`
   - If retry count is already 1, transition to `Failed` and post a summary

6. **End-state summary**: When a handoff reaches `Merged` or `Failed`, post a final summary comment with:
   - Total wall-clock time from first spec review to merge/failure
   - Total API cost across all steps (parsed from execution cost comments)
   - Retry count
   - Final state and reason

## Execution Steps

### Step 0: Branch + initial commit
```bash
git checkout -b feat/handoff-lifecycle-orchestrator
git push -u origin feat/handoff-lifecycle-orchestrator
```

### Pre-flight Self-Check
- [ ] `.github/actions/tlm-review/` exists (reference for action structure)
- [ ] `.github/workflows/execute-handoff.yml` exists and supports `workflow_dispatch`
- [ ] No existing `.github/workflows/handoff-orchestrator.yml` (avoid conflicts)
- [ ] No existing `.github/actions/handoff-orchestrator/` directory

### Step 1: Create state machine module
Create `.github/actions/handoff-orchestrator/src/state.ts` with:
- `HandoffState` enum with all states from the state machine above
- `HandoffLifecycle` interface: `{ state, branch, handoffFile, retryCount, transitions[], startedAt, completedAt, totalCost }`
- `Transition` interface: `{ from, to, trigger, timestamp, details }`
- `applyTransition(lifecycle, event)` pure function that returns the new lifecycle or throws on invalid transition
- `isTerminal(state)` helper

### Step 2: Create orchestrator action entry point
Create `.github/actions/handoff-orchestrator/src/index.ts` with:
- Event routing: inspect `github.context.eventName` and `github.context.payload` to determine which pipeline step just completed
- For `workflow_run` events: map workflow name + conclusion to state transition
- For `pull_request.closed` events: if merged, transition to `Merged`
- State load/save via artifacts API
- PR comment update logic (find existing comment by marker, update or create)
- Retry trigger logic (call `octokit.rest.actions.createWorkflowDispatch`)

### Step 3: Create action.yml and package.json
- `action.yml`: composite action definition with inputs and the node20 runtime
- `package.json`: dependencies on `@actions/core`, `@actions/github`, `@actions/artifact`
- `tsconfig.json`: same config as `tlm-review` action

### Step 4: Create orchestrator workflow
Create `.github/workflows/handoff-orchestrator.yml` with the triggers, concurrency group, and step that runs the action.

### Step 5: Build the action
```bash
cd .github/actions/handoff-orchestrator
npm install
npx tsc
npx ncc build src/index.ts -o dist
```
Commit the built `dist/` output.

### Step 6: Verify
- `npx tsc --noEmit` passes in the action directory
- Build succeeds
- Workflow YAML is valid
- No modifications to existing workflow files (this is purely additive)
- The orchestrator does not import from or depend on the TLM review action code

### Step 7: Commit and push
Commit all changes. Push to the branch. Open a PR against main.

Note: This PR creates files under `.github/actions/` which is in the sensitive path patterns list. TLM Code Review will flag for human review. This is correct.

## Session Abort Protocol
If build fails after 3 attempts:
1. Revert to last known-good state
2. Post a PR comment documenting what was attempted and what failed
3. Push the partial work (state machine module is independently useful even without the full action)
4. Exit with failure

## Acceptance Criteria
- Orchestrator workflow triggers on all relevant pipeline events
- State machine correctly models the handoff lifecycle with all transitions
- PR comment shows a clear, updating lifecycle table
- Retry mechanism triggers execute-handoff with CI failure context
- Maximum 1 automatic retry, then fails with summary
- No modifications to existing workflows (purely additive)
- End-state summary captures total time and cost
