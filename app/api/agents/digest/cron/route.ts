import { NextResponse } from 'next/server';
import { buildDailyDigest, renderDigestHtml } from '@/lib/digest';
import { sendHtmlEmail } from '@/lib/gmail';

export const maxDuration = 60;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const digest = await buildDailyDigest();
    const html = renderDigestHtml(digest);

    const recipientEmail =
      process.env.GMAIL_DIGEST_RECIPIENT ?? 'james.stine.heath@gmail.com';
    const subject = `Agent Forge Daily Digest \u2014 ${digest.healthSummary}`;

    await sendHtmlEmail({
      to: recipientEmail,
      subject,
      html,
    });

    return NextResponse.json({
      ok: true,
      sentAt: digest.generatedAt.toISOString(),
      healthSummary: digest.healthSummary,
      stats: {
        mergedPRs: digest.mergedPRs.length,
        openPRs: digest.openPRs.length,
        workItemsActive: digest.workItemStats.dispatched.length,
        workItemsCompleted: digest.workItemStats.completed.length,
        workItemsFailed: digest.workItemStats.failed.length,
        workItemsStuck: digest.workItemStats.stuck.length,
        escalations: digest.escalations.length,
        events: digest.eventStats.total,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[digest/cron] Error:', message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
