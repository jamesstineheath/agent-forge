import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { sendHtmlEmail } from "@/lib/gmail";
import { sendWithFallback, sendSlackFlagForHuman } from "@/lib/slack";

interface FlagForHumanPayload {
  repo: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  summary: string;
  riskAssessment: string;
  options: string[];
  recommendedPath: string;
}

export async function POST(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  try {
    const body = (await req.json()) as FlagForHumanPayload;

    const { repo, prNumber, prTitle, prUrl, summary, riskAssessment, options, recommendedPath } = body;

    if (!repo || !prNumber || !prTitle || !prUrl || !summary) {
      return NextResponse.json(
        { error: "Missing required fields: repo, prNumber, prTitle, prUrl, summary" },
        { status: 400 }
      );
    }

    const optionsHtml = (options ?? [])
      .map((opt, i) => `<li><strong>Option ${i + 1}:</strong> ${opt}</li>`)
      .join("\n");

    const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
  <h2 style="color: #d97706; border-bottom: 2px solid #d97706; padding-bottom: 8px;">
    Pipeline Decision Required
  </h2>

  <p><strong>Repository:</strong> ${repo}</p>
  <p><strong>PR:</strong> <a href="${prUrl}">#${prNumber} &mdash; ${prTitle}</a></p>

  <h3 style="color: #1f2937;">What&rsquo;s at stake</h3>
  <p>${summary}</p>

  <h3 style="color: #1f2937;">Risk Assessment</h3>
  <p>${riskAssessment || "No risk assessment provided."}</p>

  ${optionsHtml ? `<h3 style="color: #1f2937;">Options</h3><ol>${optionsHtml}</ol>` : ""}

  ${recommendedPath ? `<h3 style="color: #059669;">Recommended Path</h3><p>${recommendedPath}</p>` : ""}

  <hr style="margin: 24px 0; border: none; border-top: 1px solid #e5e7eb;" />
  <p style="font-size: 14px; color: #6b7280;">
    <a href="${prUrl}" style="color: #2563eb;">View PR on GitHub &rarr;</a>
  </p>
</div>
`;

    const result = await sendWithFallback(
      () => sendSlackFlagForHuman({ repo, prNumber, prTitle, prUrl, summary, riskAssessment, options, recommendedPath }),
      () => sendHtmlEmail({
        to: "james.stine.heath@gmail.com",
        subject: `[Pipeline Decision] PR #${prNumber} — ${prTitle}`,
        html,
      })
    );

    return NextResponse.json({ sent: true, channel: result.channel, threadId: result.id });
  } catch (err) {
    console.error("[api/notify/flag-for-human] Error:", err);
    return NextResponse.json(
      { error: "Failed to send notification" },
      { status: 500 }
    );
  }
}
