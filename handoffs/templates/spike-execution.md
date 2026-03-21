# Spike Execution Protocol

## What Are Spike Handoffs?

Spike handoffs are time-boxed technical research tasks dispatched through the Agent Forge pipeline. Unlike feature or bugfix handoffs, spikes produce **findings documents** rather than code changes. They answer a specific technical question and provide a recommendation (GO / GO_WITH_CHANGES / NO_GO) that informs the parent PRD's next steps.

## When Spikes Are Created

Spikes are created when:
- The Project Manager agent identifies a technical uncertainty that blocks PRD planning
- A manual operator files a spike work item via the dashboard
- The `spikeMetadata` field on the work item defines the investigation parameters

## What Spike Agents Must Do

1. **Investigate** the technical question defined in `spikeMetadata.technicalQuestion`
2. **Create** the `spikes/` directory if it does not exist
3. **Write findings** to `spikes/<work-item-id>.md` using the spike findings template from `lib/spike-template.ts`
4. **Provide a recommendation**: GO, GO_WITH_CHANGES, or NO_GO
5. **Commit and push** findings, then open a PR

## What Spike Agents Must NOT Do

- Modify any production code files (anything outside `spikes/`)
- Install new dependencies
- Create or modify tests
- Change configuration files
- Make architectural changes

## Output Format

All spike findings use the template defined in `lib/spike-template.ts`:

```markdown
## Parent PRD
<parent-prd-id>

## Technical Question
<the question being investigated>

## What Was Tried
<description of investigation approach>

## Detailed Findings
<evidence-based summary>

## Recommendation (GO / GO_WITH_CHANGES / NO_GO)
<one of: GO, GO_WITH_CHANGES, NO_GO>

## Implications for Parent PRD
<how findings affect parent PRD scope, design, or timeline>
```

## Lifecycle

1. Work item with `type: "spike"` reaches `ready` status
2. Orchestrator detects spike type and generates a spike-specific handoff (via `generateSpikeHandoff`)
3. Handoff is pushed to the target repo and executed
4. Agent writes findings to `spikes/<id>.md` and opens a PR
5. Findings are reviewed and merged
6. Parent PRD work items can proceed informed by the spike's recommendation
