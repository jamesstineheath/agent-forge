# Plan Status: Plan Dashboard — Review, Approve, Monitor

## Progress
- [x] AC5: usePlans SWR hook — `lib/hooks.ts`
- [x] AC1: Plan detail view — `app/(app)/plans/[id]/page.tsx`
- [x] AC2: Review panel for needs_review — detail page + list attention indicator
- [x] AC3: Summary card — plans list page
- [x] AC4: Error log + retry — detail page

## Decisions
- Added "parked" to PlanStatus for reject/park functionality
- Both pages refactored to use SWR hooks instead of manual fetch+setInterval
- AUTO_DISPATCH_CAP shown as $100 in review panel (matches dispatcher logic)
- Retry panel includes optional feedback textarea
