import { NextRequest, NextResponse } from 'next/server';
import { sendEscalationEmail } from '@/lib/gmail';
import type { Escalation } from '@/lib/escalation';
import type { WorkItem } from '@/lib/types';

export async function POST(request: NextRequest) {
  // Only allow in development or with dev query param
  const isDev = process.env.NODE_ENV === 'development';
  const hasDevParam = request.nextUrl.searchParams.get('dev') === 'true';

  if (!isDev && !hasDevParam) {
    return NextResponse.json({ error: 'Test endpoint not available' }, { status: 403 });
  }

  try {
    const body = await request.json();

    // Use provided work item or create a mock
    const workItem: WorkItem = body.workItem || {
      id: 'test-work-item',
      title: body.title || 'Test Work Item',
      description: 'Test work item for email verification',
      targetRepo: 'test/repo',
      source: { type: 'manual' as const },
      priority: 'medium' as const,
      riskLevel: 'low' as const,
      complexity: 'simple' as const,
      status: 'blocked' as const,
      dependencies: [],
      handoff: null,
      execution: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const escalation: Escalation = body.escalation || {
      id: 'test-escalation-' + Date.now(),
      workItemId: workItem.id,
      reason: body.reason || 'Test escalation via API',
      confidenceScore: 0.95,
      contextSnapshot: {
        endpoint: '/api/escalations/test-email',
        timestamp: new Date().toISOString(),
        testRun: true,
      },
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    };

    const threadId = await sendEscalationEmail(escalation, workItem);

    if (threadId) {
      return NextResponse.json(
        {
          success: true,
          message: 'Test escalation email sent successfully',
          threadId,
          escalation,
        },
        { status: 200 }
      );
    } else {
      return NextResponse.json(
        {
          success: false,
          message: 'Gmail credentials not configured. Email not sent. (Graceful degradation mode)',
          escalation,
        },
        { status: 200 }
      );
    }
  } catch (error) {
    console.error('[Test Email] Error:', error);
    return NextResponse.json(
      { error: 'Failed to send test email', details: String(error) },
      { status: 500 }
    );
  }
}
