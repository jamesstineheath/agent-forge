# Agent Forge -- Create FORCE_OPUS Kill Switch API and Dashboard Toggle

## Metadata
- **Branch:** `feat/force-opus-kill-switch`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/api/config/force-opus/route.ts, app/components/force-opus-toggle.tsx, app/page.tsx

## Context

Agent Forge is a dev orchestration platform (Next.js App Router on Vercel) that dispatches autonomous agents to target repos. Model selection is currently policy-driven per work item, but there is a need for an operator-level kill switch that forces all pipeline calls to Claude Opus regardless of individual work item policy.

This task implements:
1. A Vercel Blob-backed API endpoint for reading and writing the FORCE_OPUS config
2. A React dashboard component with SWR data fetching and a confirmation-gated toggle
3. Integration of the toggle into the existing dashboard root page

### Existing Patterns to Follow

**Auth pattern** — API routes in this repo authenticate via either session (Auth.js v5) or `CRON_SECRET` bearer token. See how other routes handle this (e.g., cron routes check `Authorization: Bearer ${CRON_SECRET}`).

**Blob storage** — Config/state is stored in Vercel Blob under `af-data/` prefix. Use `@vercel/blob` `put` and `getDownloadUrl`/`list` or `head` + fetch pattern. The blob token is `BLOB_READ_WRITE_TOKEN`.

**SWR pattern** — `lib/hooks.ts` contains existing SWR hooks. The `ForceOpusToggle` component can define its own inline SWR call following the same pattern.

**Page structure** — `app/page.tsx` is the dashboard root. It imports components and renders a grid/flex layout of dashboard widgets.

**Storage helper** — `lib/storage.ts` exports Blob CRUD helpers. Prefer using those if they fit; otherwise use `@vercel/blob` directly for simplicity.

## Requirements

1. `GET /api/config/force-opus` returns `{ enabled: boolean, activatedAt: string|null, activatedBy: string|null }`. Returns `{ enabled: false, activatedAt: null, activatedBy: null }` when no config exists yet.
2. `POST /api/config/force-opus` accepts `{ enabled: boolean }` in the request body, writes a `ForceOpusConfig` object to `af-data/config/force-opus.json` in Vercel Blob with `activatedAt = new Date().toISOString()` and `activatedBy = 'operator'`, and returns the updated config.
3. Both GET and POST require authentication: either a valid session (Auth.js) OR `Authorization: Bearer <CRON_SECRET>` header.
4. `ForceOpusToggle` React component (`app/components/force-opus-toggle.tsx`) displays current state (enabled/disabled badge, `activatedAt` timestamp if set), renders a toggle button, and shows a confirmation dialog before committing (`"Are you sure? All pipeline calls will use Opus."`).
5. `ForceOpusToggle` uses SWR to fetch `/api/config/force-opus` and `fetch` POST to toggle.
6. `app/page.tsx` imports and renders `ForceOpusToggle` in the dashboard.
7. `npm run build` passes with no TypeScript errors.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/force-opus-kill-switch
```

### Step 1: Inspect existing patterns
```bash
# Check existing auth patterns in API routes
cat app/api/agents/dispatcher/cron/route.ts
cat app/api/pm-agent/route.ts

# Check storage helpers
cat lib/storage.ts

# Check SWR hooks pattern
cat lib/hooks.ts

# Check current dashboard page
cat app/page.tsx

# Check existing component patterns
ls app/components/
```

### Step 2: Create the API route

Create `app/api/config/force-opus/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth'; // Auth.js v5 pattern used in this repo
import { put, list } from '@vercel/blob';

const BLOB_KEY = 'af-data/config/force-opus.json';

interface ForceOpusConfig {
  enabled: boolean;
  activatedAt: string | null;
  activatedBy: string | null;
}

const DEFAULT_CONFIG: ForceOpusConfig = {
  enabled: false,
  activatedAt: null,
  activatedBy: null,
};

async function isAuthorized(req: NextRequest): Promise<boolean> {
  // Check CRON_SECRET bearer token
  const authHeader = req.headers.get('authorization');
  if (authHeader && authHeader === `Bearer ${process.env.CRON_SECRET}`) {
    return true;
  }
  // Check session auth
  const session = await auth();
  return !!session?.user;
}

async function readConfig(): Promise<ForceOpusConfig> {
  try {
    const { blobs } = await list({ prefix: 'af-data/config/force-opus' });
    if (blobs.length === 0) return DEFAULT_CONFIG;
    const res = await fetch(blobs[0].downloadUrl);
    if (!res.ok) return DEFAULT_CONFIG;
    return await res.json() as ForceOpusConfig;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const config = await readConfig();
  return NextResponse.json(config);
}

export async function POST(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { enabled: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: '`enabled` must be a boolean' }, { status: 400 });
  }

  const config: ForceOpusConfig = {
    enabled: body.enabled,
    activatedAt: new Date().toISOString(),
    activatedBy: 'operator',
  };

  await put(BLOB_KEY, JSON.stringify(config), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
  });

  return NextResponse.json(config);
}
```

> **Note:** Adjust the `auth()` import path if Auth.js is imported differently in this repo (check existing routes). If `lib/storage.ts` has a simpler `readBlob`/`writeBlob` helper, prefer those over raw `@vercel/blob` calls — inspect the file first.

### Step 3: Create the ForceOpusToggle component

Create `app/components/force-opus-toggle.tsx`:

```tsx
'use client';

import useSWR from 'swr';
import { useState } from 'react';

interface ForceOpusConfig {
  enabled: boolean;
  activatedAt: string | null;
  activatedBy: string | null;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function ForceOpusToggle() {
  const { data, error, isLoading, mutate } = useSWR<ForceOpusConfig>(
    '/api/config/force-opus',
    fetcher,
    { refreshInterval: 30_000 }
  );
  const [confirming, setConfirming] = useState(false);
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  const handleToggleClick = () => {
    if (!data) return;
    setPendingEnabled(!data.enabled);
    setConfirming(true);
  };

  const handleConfirm = async () => {
    if (pendingEnabled === null) return;
    setSaving(true);
    try {
      const res = await fetch('/api/config/force-opus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: pendingEnabled }),
      });
      if (res.ok) {
        const updated = await res.json();
        mutate(updated, false);
      }
    } finally {
      setSaving(false);
      setConfirming(false);
      setPendingEnabled(null);
    }
  };

  const handleCancel = () => {
    setConfirming(false);
    setPendingEnabled(null);
  };

  if (isLoading) {
    return (
      <div className="rounded-lg border p-4">
        <h3 className="font-semibold text-sm text-gray-500 mb-2">FORCE OPUS</h3>
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-lg border p-4">
        <h3 className="font-semibold text-sm text-gray-500 mb-2">FORCE OPUS</h3>
        <p className="text-sm text-red-400">Failed to load config</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <h3 className="font-semibold text-sm text-gray-500 uppercase tracking-wide">
        Force Opus Kill Switch
      </h3>

      <div className="flex items-center gap-3">
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
            data.enabled
              ? 'bg-red-100 text-red-800'
              : 'bg-green-100 text-green-800'
          }`}
        >
          {data.enabled ? 'ACTIVE — Opus Forced' : 'Inactive — Policy Routing'}
        </span>
      </div>

      {data.enabled && data.activatedAt && (
        <p className="text-xs text-gray-500">
          Activated {new Date(data.activatedAt).toLocaleString()} by{' '}
          {data.activatedBy ?? 'unknown'}
        </p>
      )}

      {!confirming ? (
        <button
          onClick={handleToggleClick}
          className={`text-sm px-3 py-1.5 rounded font-medium transition-colors ${
            data.enabled
              ? 'bg-gray-100 hover:bg-gray-200 text-gray-700'
              : 'bg-orange-500 hover:bg-orange-600 text-white'
          }`}
        >
          {data.enabled ? 'Deactivate' : 'Force Opus'}
        </button>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
            {pendingEnabled
              ? 'Are you sure? All pipeline calls will use Opus.'
              : 'Deactivate FORCE OPUS and resume policy-based routing?'}
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              disabled={saving}
              className="text-sm px-3 py-1.5 rounded font-medium bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Confirm'}
            </button>
            <button
              onClick={handleCancel}
              disabled={saving}
              className="text-sm px-3 py-1.5 rounded font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

### Step 4: Integrate into the dashboard

Open `app/page.tsx` and add the import and component:

```bash
# First, inspect current page.tsx structure
cat app/page.tsx
```

Add the import near the top of `app/page.tsx`:
```tsx
import { ForceOpusToggle } from '@/app/components/force-opus-toggle';
```

Add `<ForceOpusToggle />` to the dashboard layout. Find an appropriate spot (e.g., alongside agent health widgets or in a settings/config section). Example:

```tsx
{/* Config / Kill Switches */}
<div className="col-span-1">
  <ForceOpusToggle />
</div>
```

> If `app/page.tsx` is a server component (no `'use client'`), `ForceOpusToggle` is already `'use client'` so it can be imported directly. No changes needed to the page's own directive.

### Step 5: Verify auth import path

```bash
# Find how auth() is imported in existing routes
grep -r "from '@/auth'" app/api/ | head -5
grep -r "from 'next-auth'" app/api/ | head -5
grep -r "getServerSession\|auth()" app/api/ | head -10
```

Adjust the import in `app/api/config/force-opus/route.ts` to match the existing pattern exactly.

### Step 6: Verify storage pattern

```bash
# Check if storage.ts has blob helpers we should use
grep -n "export" lib/storage.ts | head -20
```

If `lib/storage.ts` exports something like `readBlob(key)` / `writeBlob(key, data)`, refactor the route to use those instead of raw `@vercel/blob` for consistency.

### Step 7: TypeScript check and build
```bash
npx tsc --noEmit
npm run build
```

Fix any TypeScript errors before proceeding.

### Step 8: Commit, push, open PR
```bash
git add -A
git commit -m "feat: add FORCE_OPUS kill switch API and dashboard toggle"
git push origin feat/force-opus-kill-switch
gh pr create \
  --title "feat: add FORCE_OPUS kill switch API and dashboard toggle" \
  --body "## Summary
Implements the FORCE_OPUS operator kill switch.

### Changes
- \`app/api/config/force-opus/route.ts\`: GET/POST endpoints backed by Vercel Blob (\`af-data/config/force-opus.json\`). Auth via session or CRON_SECRET bearer token.
- \`app/components/force-opus-toggle.tsx\`: React client component with SWR polling, status badge, and confirmation-gated toggle.
- \`app/page.tsx\`: Integrates \`ForceOpusToggle\` into the dashboard.

### Acceptance Criteria
- [x] GET returns \`{ enabled, activatedAt, activatedBy }\` (defaults to disabled when no config exists)
- [x] POST persists config to Vercel Blob and returns updated state
- [x] Toggle shows confirmation dialog before committing
- [x] Build passes"
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/force-opus-kill-switch
FILES CHANGED: [list what was modified]
SUMMARY: [what was completed]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains to reach full acceptance criteria]
```

## Escalation Protocol

If blocked on ambiguous auth patterns, missing `@vercel/blob` types, or architectural decisions, escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "force-opus-kill-switch",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": [
        "app/api/config/force-opus/route.ts",
        "app/components/force-opus-toggle.tsx",
        "app/page.tsx"
      ]
    }
  }'
```