import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { getWorkItem, updateWorkItem } from "@/lib/work-items";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = await validateAuth(req, "WORK_ITEMS_API_KEY");
  if (authError) return authError;

  const { id } = await params;

  const item = await getWorkItem(id);
  if (!item) {
    return NextResponse.json({ error: "Work item not found" }, { status: 404 });
  }

  if (item.status !== "escalated") {
    return NextResponse.json(
      {
        error: `Cannot retry item with status '${item.status}'. Item must be in 'escalated' status.`,
      },
      { status: 400 }
    );
  }

  // Parse optional budget override
  let budgetOverride: number | undefined;
  try {
    const body = await req.json();
    if (body.budget !== undefined) {
      const parsed = Number(body.budget);
      if (isNaN(parsed) || parsed <= 0) {
        return NextResponse.json(
          { error: "budget must be a positive number" },
          { status: 400 }
        );
      }
      budgetOverride = parsed;
    }
  } catch {
    // No body or invalid JSON — treat as no budget override
  }

  // Transition to 'filed' and clear escalation
  const updates: Parameters<typeof updateWorkItem>[1] = {
    status: "filed",
    escalation: undefined,
  };

  // Override handoff budget if provided and handoff exists
  if (budgetOverride !== undefined && item.handoff) {
    updates.handoff = {
      ...item.handoff,
      budget: budgetOverride,
    };
  }

  const updated = await updateWorkItem(id, updates);

  return NextResponse.json(updated);
}
