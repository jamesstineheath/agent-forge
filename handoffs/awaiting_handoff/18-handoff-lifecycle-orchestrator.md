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

The orchestrator is implemented as a GitHub Actions workflow + Node action, not as an ATC feature. Rationale:
- The pipeline runs in GitHub Actions. State transitions happen there.
- ATC runs in the Agent Forge Vercel deployment. Cross-system state sync adds complexity with no benefit at this scale.
- GitHub Actions has native access to workflow run status, check suites, and PR state.
- State is persisted as a JSON artifact uploaded per orchestrator run, retrieved across runs via the GitHub REST API (`actions.listArtifacts` filtered by branch name in the artifact name).

When the ATC-driven Project Autopilot dispatches work items to the pipeline, the orchestrator's state becomes queryable via the GitHub API. A future integration (not in scope here) could have the ATC poll orchestrator state to detect stuck items.

### State machine

Each handoff transitions through these states:
