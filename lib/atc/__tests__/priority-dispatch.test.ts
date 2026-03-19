/**
 * Integration test: end-to-end priority dispatch ordering
 *
 * Verifies that Priority type, DEFAULT_PRIORITY/DEFAULT_RANK constants,
 * and dispatchSortComparator all work together correctly across the full
 * priority-aware dispatch pipeline.
 */

import { describe, it, expect } from 'vitest';
import type { Priority, WorkItem } from '../../types';
import { DEFAULT_PRIORITY, DEFAULT_RANK, dispatchSortComparator } from '../utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(
  id: string,
  overrides: Partial<Pick<WorkItem, 'triagePriority' | 'rank' | 'createdAt'>> = {}
): WorkItem {
  return {
    id,
    title: `Work item ${id}`,
    description: '',
    targetRepo: 'jamesstineheath/agent-forge',
    source: { type: 'manual' },
    priority: 'medium',
    riskLevel: 'low',
    complexity: 'simple',
    status: 'ready',
    dependencies: [],
    handoff: null,
    execution: null,
    createdAt: new Date('2024-01-01T00:00:00Z').toISOString(),
    updatedAt: new Date('2024-01-01T00:00:00Z').toISOString(),
    ...overrides,
  };
}

function sortItems(items: WorkItem[]): WorkItem[] {
  return [...items].sort(dispatchSortComparator);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('Priority dispatch constants', () => {
  it('DEFAULT_PRIORITY should be P1', () => {
    expect(DEFAULT_PRIORITY).toBe('P1');
  });

  it('DEFAULT_RANK should be 999', () => {
    expect(DEFAULT_RANK).toBe(999);
  });
});

// ---------------------------------------------------------------------------
// Type safety (compile-time)
// ---------------------------------------------------------------------------

describe('Priority type', () => {
  it('accepts P0, P1, P2 as valid Priority values', () => {
    const p0: Priority = 'P0';
    const p1: Priority = 'P1';
    const p2: Priority = 'P2';
    expect(['P0', 'P1', 'P2']).toContain(p0);
    expect(['P0', 'P1', 'P2']).toContain(p1);
    expect(['P0', 'P1', 'P2']).toContain(p2);
  });
});

// ---------------------------------------------------------------------------
// Basic priority ordering
// ---------------------------------------------------------------------------

describe('dispatchSortComparator — basic priority ordering', () => {
  it('sorts [P2, P0, P1] into [P0, P1, P2]', () => {
    const items = [
      makeItem('c', { triagePriority: 'P2', rank: 1 }),
      makeItem('a', { triagePriority: 'P0', rank: 5 }),
      makeItem('b', { triagePriority: 'P1', rank: 3 }),
    ];
    const sorted = sortItems(items);
    expect(sorted.map((i) => i.triagePriority)).toEqual(['P0', 'P1', 'P2']);
    expect(sorted.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('P0 items always come before P1 items', () => {
    const items = [
      makeItem('p1-item', { triagePriority: 'P1', rank: 1 }),
      makeItem('p0-item', { triagePriority: 'P0', rank: 100 }),
    ];
    const sorted = sortItems(items);
    expect(sorted[0].triagePriority).toBe('P0');
    expect(sorted[1].triagePriority).toBe('P1');
  });

  it('P1 items always come before P2 items', () => {
    const items = [
      makeItem('p2-item', { triagePriority: 'P2', rank: 1 }),
      makeItem('p1-item', { triagePriority: 'P1', rank: 100 }),
    ];
    const sorted = sortItems(items);
    expect(sorted[0].triagePriority).toBe('P1');
    expect(sorted[1].triagePriority).toBe('P2');
  });
});

// ---------------------------------------------------------------------------
// Rank ordering within same priority
// ---------------------------------------------------------------------------

describe('dispatchSortComparator — rank ordering within same priority', () => {
  it('sorts lower rank numbers first within the same priority', () => {
    const items = [
      makeItem('rank-5', { triagePriority: 'P1', rank: 5 }),
      makeItem('rank-1', { triagePriority: 'P1', rank: 1 }),
      makeItem('rank-3', { triagePriority: 'P1', rank: 3 }),
    ];
    const sorted = sortItems(items);
    expect(sorted.map((i) => i.rank)).toEqual([1, 3, 5]);
    expect(sorted.map((i) => i.id)).toEqual(['rank-1', 'rank-3', 'rank-5']);
  });

  it('all same priority — falls through to rank then createdAt', () => {
    const items = [
      makeItem('b', { triagePriority: 'P0', rank: 2, createdAt: '2024-01-02T00:00:00Z' }),
      makeItem('a', { triagePriority: 'P0', rank: 2, createdAt: '2024-01-01T00:00:00Z' }),
      makeItem('c', { triagePriority: 'P0', rank: 1, createdAt: '2024-01-03T00:00:00Z' }),
    ];
    const sorted = sortItems(items);
    expect(sorted[0].id).toBe('c');   // rank 1 wins
    expect(sorted[1].id).toBe('a');   // rank 2, earlier createdAt
    expect(sorted[2].id).toBe('b');   // rank 2, later createdAt
  });
});

// ---------------------------------------------------------------------------
// createdAt tiebreaker
// ---------------------------------------------------------------------------

describe('dispatchSortComparator — createdAt tiebreaker', () => {
  it('earlier createdAt wins when priority and rank are identical', () => {
    const items = [
      makeItem('later',   { triagePriority: 'P1', rank: 1, createdAt: '2024-06-01T00:00:00Z' }),
      makeItem('earlier', { triagePriority: 'P1', rank: 1, createdAt: '2024-01-01T00:00:00Z' }),
    ];
    const sorted = sortItems(items);
    expect(sorted[0].id).toBe('earlier');
    expect(sorted[1].id).toBe('later');
  });
});

// ---------------------------------------------------------------------------
// Legacy items (no priority / no rank)
// ---------------------------------------------------------------------------

describe('dispatchSortComparator — legacy items default to P1/999', () => {
  it('legacy item (no triagePriority, no rank) sorts between P0 and P2', () => {
    const items = [
      makeItem('p2',     { triagePriority: 'P2', rank: 1 }),
      makeItem('legacy', {}),  // no triagePriority, no rank
      makeItem('p0',     { triagePriority: 'P0', rank: 1 }),
    ];
    const sorted = sortItems(items);
    expect(sorted[0].id).toBe('p0');
    expect(sorted[1].id).toBe('legacy');
    expect(sorted[2].id).toBe('p2');
  });

  it('legacy item sorts at rank 999 within P1 tier', () => {
    const items = [
      makeItem('p1-rank-1',   { triagePriority: 'P1', rank: 1 }),
      makeItem('legacy',      {}),   // defaults to P1/999
      makeItem('p1-rank-500', { triagePriority: 'P1', rank: 500 }),
    ];
    const sorted = sortItems(items);
    expect(sorted[0].id).toBe('p1-rank-1');
    expect(sorted[1].id).toBe('p1-rank-500');
    expect(sorted[2].id).toBe('legacy');
  });
});

// ---------------------------------------------------------------------------
// Mixed undefined fields
// ---------------------------------------------------------------------------

describe('dispatchSortComparator — mixed undefined fields', () => {
  it('item with triagePriority but no rank defaults rank to DEFAULT_RANK (999)', () => {
    const items = [
      makeItem('p1-no-rank',  { triagePriority: 'P1' }),          // rank undefined → 999
      makeItem('p1-rank-500', { triagePriority: 'P1', rank: 500 }),
    ];
    const sorted = sortItems(items);
    expect(sorted[0].id).toBe('p1-rank-500');
    expect(sorted[1].id).toBe('p1-no-rank');
  });

  it('item with rank but no triagePriority defaults priority to DEFAULT_PRIORITY (P1)', () => {
    const items = [
      makeItem('no-priority-rank-1', { rank: 1 }),   // triagePriority undefined → P1
      makeItem('p0-rank-5',          { triagePriority: 'P0', rank: 5 }),
      makeItem('p2-rank-1',          { triagePriority: 'P2', rank: 1 }),
    ];
    const sorted = sortItems(items);
    expect(sorted[0].id).toBe('p0-rank-5');
    expect(sorted[1].id).toBe('no-priority-rank-1');  // treated as P1/1
    expect(sorted[2].id).toBe('p2-rank-1');
  });

  it('all undefined triagePriority/rank items sort stably by createdAt', () => {
    const items = [
      makeItem('c', { createdAt: '2024-03-01T00:00:00Z' }),
      makeItem('a', { createdAt: '2024-01-01T00:00:00Z' }),
      makeItem('b', { createdAt: '2024-02-01T00:00:00Z' }),
    ];
    const sorted = sortItems(items);
    expect(sorted.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});
