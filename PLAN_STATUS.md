# PRD-61 Plan Status

## Rescoping
- AC-1 (orchestrator migration): OBSOLETE per Pipeline v2 rescoping note
- AC-2 (FORCE_SONNET toggle): COMPLETED
- AC-3 (per-model analytics): ALREADY EXISTS at /model-routing dashboard

## AC-2: FORCE_SONNET Toggle
- Created `/app/api/config/force-sonnet/route.ts` — mirrors force-opus API pattern
- Created `/components/settings-force-sonnet.tsx` — UI toggle with confirmation flow
- Added to Settings page between Force Opus and Concurrency controls
- Uses blue color scheme (vs orange for Force Opus) to distinguish cost-reduction vs quality-safety
- Stores config at `config/force-sonnet` in Vercel Blob

## AC-3: Per-Model Analytics
- Already shipped: `/app/(app)/model-routing/page.tsx` + `/app/components/model-routing-dashboard.tsx`
- Displays: per-model cost breakdown, daily spend, quality scores, escalation rates, Phase 1 ROI
- API at `/api/analytics/model-routing` with time range + task type filters
- Linked in sidebar navigation under Workflow section
