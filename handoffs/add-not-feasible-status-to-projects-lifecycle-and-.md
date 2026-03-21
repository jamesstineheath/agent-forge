# Agent Forge -- Add 'Not Feasible' Status to Projects Lifecycle and Notion Integration

## Metadata
- **Branch:** `feat/not-feasible-status`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/projects.ts, lib/notion.ts

## Context

Agent Forge manages projects through a lifecycle with terminal statuses (`Complete`, `Failed`). A new terminal status `Not Feasible` needs to be added to the project lifecycle logic and Notion integration. This status should behave identically to `Complete` and `Failed` — once a project reaches `Not Feasible`, no further transitions are allowed out of it.

The two files to modify:
- `lib/projects.ts` — Contains lifecycle transition logic. Currently treats `Complete` and `Failed` as terminal states. Need to add `Not Feasible` to any terminal state checks, guard clauses, or filtering logic.
- `lib/notion.ts` — Contains the Notion API client. Used to read/write project status on Notion PRD pages. Need to ensure `Not Feasible` is accepted as a valid status value when updating a page's status property.

There are no new dependencies required. This is a purely additive change.

## Requirements

1. `lib/projects.ts` must treat `'Not Feasible'` as a terminal status — no valid outbound transitions exist from it.
2. Any status validation arrays or filtering logic in `lib/projects.ts` that checks for terminal states must include `'Not Feasible'`.
3. `lib/notion.ts` must accept and correctly pass `'Not Feasible'` as a status value when updating a Notion page's status property.
4. Any status allow-lists or type unions in `lib/notion.ts` must include `'Not Feasible'`.
5. Existing transitions for `Complete` and `Failed` must remain unchanged.
6. TypeScript must compile without errors (`npx tsc --noEmit`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/not-feasible-status
```

### Step 1: Inspect the current files

Read both files in full to understand the existing patterns before making changes:

```bash
cat lib/projects.ts
cat lib/notion.ts
```

Pay close attention to:
- In `lib/projects.ts`: Any arrays, sets, or conditionals that list terminal statuses (e.g., `['Complete', 'Failed']`), any transition maps or switch statements, any TypeScript types/unions for project status.
- In `lib/notion.ts`: Any arrays, type unions, or string literals that enumerate valid Notion status values, any function signatures that accept a status parameter.

### Step 2: Update lib/projects.ts

Add `'Not Feasible'` as a terminal status everywhere `'Complete'` and `'Failed'` are treated as terminal. Common patterns to look for and update:

**Pattern A — Terminal status array/set:**
```typescript
// Before
const TERMINAL_STATUSES = ['Complete', 'Failed'];
// After
const TERMINAL_STATUSES = ['Complete', 'Failed', 'Not Feasible'];
```

**Pattern B — Conditional guard:**
```typescript
// Before
if (status === 'Complete' || status === 'Failed') return; // no transition
// After
if (status === 'Complete' || status === 'Failed' || status === 'Not Feasible') return;
```

**Pattern C — TypeScript union type:**
```typescript
// Before
type ProjectStatus = 'Filed' | 'Active' | 'Complete' | 'Failed' | ...;
// After
type ProjectStatus = 'Filed' | 'Active' | 'Complete' | 'Failed' | 'Not Feasible' | ...;
```

**Pattern D — Transition map (object/switch):**
If there is a transition map (e.g., `validTransitions: { Complete: [], Failed: [] }`), add:
```typescript
'Not Feasible': [],
```

Make all changes additive — do not modify any existing `Complete` or `Failed` logic.

### Step 3: Update lib/notion.ts

Add `'Not Feasible'` as a valid status value everywhere Notion status values are enumerated. Common patterns:

**Pattern A — Status type union or allow-list:**
```typescript
// Before
type NotionProjectStatus = 'Filed' | 'Active' | 'Complete' | 'Failed';
// After
type NotionProjectStatus = 'Filed' | 'Active' | 'Complete' | 'Failed' | 'Not Feasible';
```

**Pattern B — Validation array:**
```typescript
// Before
const VALID_STATUSES = ['Filed', 'Active', 'Complete', 'Failed'];
// After
const VALID_STATUSES = ['Filed', 'Active', 'Complete', 'Failed', 'Not Feasible'];
```

**Pattern C — Notion select option mapping:**
If the code maps internal status names to Notion select option names (they may differ), add the mapping:
```typescript
'Not Feasible': 'Not Feasible',
```

Ensure the function that sets a page's status property can pass `'Not Feasible'` through to the Notion API without being filtered out or causing a type error.

### Step 4: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

If there are type errors related to the new status, fix them. Common issues:
- A function parameter typed as a narrower union that doesn't include `'Not Feasible'` — widen the union.
- A `switch` statement with an exhaustive check — add a `case 'Not Feasible':` branch.

### Step 5: Run the build

```bash
npm run build
```

Resolve any build errors before proceeding.

### Step 6: Verification checklist

Manually verify:
- [ ] `lib/projects.ts`: `'Not Feasible'` appears in every location where `'Complete'` and `'Failed'` appear as terminal statuses.
- [ ] `lib/projects.ts`: No outbound transitions are defined for `'Not Feasible'`.
- [ ] `lib/notion.ts`: `'Not Feasible'` is accepted as a valid status parameter without type errors.
- [ ] `lib/notion.ts`: The value `'Not Feasible'` will be passed through to the Notion API call unchanged.
- [ ] `npx tsc --noEmit` exits 0.
- [ ] `npm run build` exits 0.

### Step 7: Commit, push, open PR

```bash
git add lib/projects.ts lib/notion.ts
git commit -m "feat: add 'Not Feasible' as terminal project status and Notion status value"
git push origin feat/not-feasible-status
gh pr create \
  --title "feat: add 'Not Feasible' status to projects lifecycle and Notion integration" \
  --body "## Summary

Adds \`Not Feasible\` as a valid terminal project status, consistent with \`Complete\` and \`Failed\`.

## Changes

### lib/projects.ts
- Added \`'Not Feasible'\` to terminal status checks — no outbound transitions defined
- Updated any status type unions and validation arrays to include the new status

### lib/notion.ts
- Added \`'Not Feasible'\` to valid Notion status values
- Ensured the status can be set on Notion PRD pages via the API client

## Acceptance Criteria
- [x] lib/projects.ts treats 'Not Feasible' as a terminal status with no valid outbound transitions
- [x] lib/notion.ts can update a page's status property to 'Not Feasible'
- [x] Existing status transitions (Complete, Failed) continue to work unchanged
- [x] TypeScript compiles without errors
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/not-feasible-status
FILES CHANGED: [list files actually modified]
SUMMARY: [what was done]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains]
```

### Escalation

If you encounter an architectural blocker (e.g., the Notion API requires a specific select option to be pre-created in the Notion database before it can be set via API, and you cannot determine if `'Not Feasible'` already exists as a configured option):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-not-feasible-status",
    "reason": "Cannot confirm whether Not Feasible select option exists in Notion database — Notion API will reject status updates if the option is not pre-configured",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "3",
      "error": "Notion select option validation uncertainty",
      "filesChanged": ["lib/projects.ts", "lib/notion.ts"]
    }
  }'
```