"use client";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export type InngestFunctionCardStatus = "idle" | "running" | "success" | "error";

export interface InngestFunctionCardProps {
  functionId: string;
  functionName: string;
  status: InngestFunctionCardStatus;
  lastRunAt: string | null;
  onTrigger: (functionId: string) => void;
  isTriggering: boolean;
}

const STATUS_CONFIG: Record<
  InngestFunctionCardStatus,
  { label: string; dotClass: string; textClass: string }
> = {
  idle: {
    label: "Idle",
    dotClass: "bg-gray-400",
    textClass: "text-gray-500",
  },
  running: {
    label: "Running",
    dotClass: "bg-blue-500 animate-pulse",
    textClass: "text-blue-600",
  },
  success: {
    label: "Success",
    dotClass: "bg-green-500",
    textClass: "text-green-600",
  },
  error: {
    label: "Error",
    dotClass: "bg-red-500",
    textClass: "text-red-600",
  },
};

function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return "just now";

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export default function InngestFunctionCard({
  functionId,
  functionName,
  status,
  lastRunAt,
  onTrigger,
  isTriggering,
}: InngestFunctionCardProps) {
  const config = STATUS_CONFIG[status];

  const handleTrigger = () => {
    if (!isTriggering) {
      onTrigger(functionId);
    }
  };

  return (
    <Card className="min-h-[140px] flex flex-col justify-between">
      <CardHeader className="pb-2">
        <h3 className="text-base font-semibold leading-tight">
          {functionName}
        </h3>
        <div className="flex items-center gap-1.5 mt-1">
          <span
            className={cn(
              "inline-block h-2.5 w-2.5 rounded-full flex-shrink-0",
              config.dotClass
            )}
            aria-hidden="true"
          />
          <span className={cn("text-xs font-medium", config.textClass)}>
            {config.label}
          </span>
        </div>
      </CardHeader>
      <CardContent className="pt-0 flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          {lastRunAt ? formatRelativeTime(lastRunAt) : "No runs yet"}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={handleTrigger}
          disabled={isTriggering}
          className="w-full mt-auto"
        >
          {isTriggering ? (
            <>
              <span
                className="mr-1.5 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
                aria-hidden="true"
              />
              Triggering…
            </>
          ) : (
            "Run Now"
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
