'use client';

import { useWaveProgress } from '@/lib/hooks';
import type { WaveGroup } from '@/lib/types';

// Helper: map status to Tailwind color classes
function waveStatusColor(status: WaveGroup['status']) {
  switch (status) {
    case 'complete': return 'text-green-600 bg-green-50 border-green-200';
    case 'active':   return 'text-blue-600 bg-blue-50 border-blue-200';
    case 'failed':   return 'text-red-600 bg-red-50 border-red-200';
    default:         return 'text-gray-500 bg-gray-50 border-gray-200';
  }
}

function itemStatusBadge(status: string) {
  const map: Record<string, string> = {
    merged:    'bg-green-100 text-green-800',
    verified:  'bg-emerald-100 text-emerald-800',
    partial:   'bg-yellow-100 text-yellow-800',
    executing: 'bg-blue-100 text-blue-800',
    reviewing: 'bg-indigo-100 text-indigo-800',
    queued:    'bg-sky-100 text-sky-800',
    generating:'bg-cyan-100 text-cyan-800',
    retrying:  'bg-orange-100 text-orange-800',
    failed:    'bg-red-100 text-red-800',
    parked:    'bg-rose-100 text-rose-800',
    blocked:   'bg-purple-100 text-purple-800',
    ready:     'bg-slate-100 text-slate-800',
    filed:     'bg-gray-100 text-gray-800',
  };
  return map[status] ?? 'bg-gray-100 text-gray-700';
}

function WaveCard({ wave }: { wave: WaveGroup }) {
  return (
    <div className={`rounded-lg border p-4 mb-3 ${waveStatusColor(wave.status)}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">Wave {wave.waveNumber}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize border ${waveStatusColor(wave.status)}`}>
            {wave.status}
          </span>
        </div>
        <span className="text-xs font-medium">
          {wave.completedItems} / {wave.totalItems} done
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-gray-200 rounded-full h-1.5 mb-3">
        <div
          className={`h-1.5 rounded-full transition-all ${
            wave.status === 'complete' ? 'bg-green-500' :
            wave.status === 'active'   ? 'bg-blue-500' :
            wave.status === 'failed'   ? 'bg-red-500' :
            'bg-gray-400'
          }`}
          style={{ width: `${wave.progressPercent}%` }}
        />
      </div>

      {/* Item list */}
      <div className="space-y-1.5">
        {wave.items.map(item => (
          <div key={item.id} className="flex items-center justify-between bg-white/60 rounded px-2 py-1">
            <span className="text-xs text-gray-700 truncate max-w-[70%]" title={item.title}>
              {item.title}
            </span>
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${itemStatusBadge(item.status)}`}>
              {item.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface WaveProgressProps {
  projectId: string;
}

export function WaveProgress({ projectId }: WaveProgressProps) {
  const { data, error, isLoading } = useWaveProgress(projectId);

  if (isLoading) {
    return (
      <div className="rounded-lg border border-gray-200 p-6 animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-1/3 mb-4" />
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-20 bg-gray-100 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600">
        Failed to load wave progress.
      </div>
    );
  }

  if (!data || data.totalWaves === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-900">Wave Progress</h3>
        <span className="text-xs text-gray-500">
          {data.totalWaves} wave{data.totalWaves !== 1 ? 's' : ''}
          {data.currentWave !== null ? ` · Wave ${data.currentWave} active` : ''}
        </span>
      </div>
      {data.waves.map(wave => (
        <WaveCard key={wave.waveNumber} wave={wave} />
      ))}
    </div>
  );
}
