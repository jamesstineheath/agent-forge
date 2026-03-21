import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import {
  readAllExecutionLogs,
  INNGEST_FUNCTION_REGISTRY,
} from "@/lib/inngest/execution-log";
import type { InngestFunctionStatus } from "@/lib/types";

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "CRON_SECRET");
  if (authError) return authError;

  let logs: Awaited<ReturnType<typeof readAllExecutionLogs>>;
  try {
    logs = await readAllExecutionLogs();
  } catch (err) {
    console.error("[inngest-status] readAllExecutionLogs failed:", err);
    return NextResponse.json(getFallbackStatuses());
  }

  const statuses: InngestFunctionStatus[] = INNGEST_FUNCTION_REGISTRY.map(
    (fn) => {
      const log = logs[fn.id];
      if (!log) {
        return {
          functionId: fn.id,
          functionName: fn.displayName,
          status: "idle" as const,
          lastRunAt: null,
        };
      }
      return {
        functionId: fn.id,
        functionName: fn.displayName,
        status: log.status === "running" ? "running" : log.status === "error" ? "error" : log.status === "success" ? "success" : "idle",
        lastRunAt: log.completedAt ?? log.startedAt ?? null,
      };
    }
  );

  return NextResponse.json(statuses);
}

function getFallbackStatuses(): InngestFunctionStatus[] {
  return INNGEST_FUNCTION_REGISTRY.map((fn) => ({
    functionId: fn.id,
    functionName: fn.displayName,
    status: "idle" as const,
    lastRunAt: null,
  }));
}
