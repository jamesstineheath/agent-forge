import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { planPipeline } from "@/lib/inngest/plan-pipeline";
import { pipelineOversight } from "@/lib/inngest/pipeline-oversight";
import { pmSweep } from "@/lib/inngest/pm-sweep";
import { housekeeping } from "@/lib/inngest/housekeeping";
import { dispatcherCycle } from "@/lib/inngest/dispatcher";
import { pmCycle } from "@/lib/inngest/pm-cycle";
import { healthMonitorCycle } from "@/lib/inngest/health-monitor";

export const maxDuration = 800;

const handler = serve({
  client: inngest,
  functions: [
    planPipeline,
    pipelineOversight,
    pmSweep,
    housekeeping,
    dispatcherCycle,
    pmCycle,
    healthMonitorCycle,
  ],
});

export const GET = handler.GET;
export const POST = handler.POST;
export const PUT = handler.PUT;
