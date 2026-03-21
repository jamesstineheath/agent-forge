/**
 * Wave Scheduler — DAG topological sort for work item dependency waves.
 *
 * Assigns each work item a "wave number" equal to the length of the longest
 * path from any root node (no dependencies) to that item. Items in the same
 * wave can be dispatched in parallel.
 */

export interface WaveAssignment {
  workItemId: string;
  waveNumber: number;
  dependsOn: string[];
  filesBeingModified: string[];
}

export interface WaveSchedulerInput {
  id: string;
  dependsOn: string[];
  filesBeingModified: string[];
  createdAt: Date;
}

/**
 * Detects circular dependencies in a set of work items using DFS.
 * Returns the cycle path as an array of IDs (first element repeated at end),
 * or null if no cycle exists.
 */
export function detectCircularDependencies(
  items: WaveSchedulerInput[]
): string[] | null {
  // Build adjacency list — only include edges where both endpoints are in the input set
  const knownIds = new Set(items.map((item) => item.id));
  const adj = new Map<string, string[]>();
  for (const item of items) {
    adj.set(
      item.id,
      (item.dependsOn ?? []).filter((dep) => knownIds.has(dep))
    );
  }

  // DFS cycle detection: white=0 (unvisited), gray=1 (in stack), black=2 (done)
  const color = new Map<string, 0 | 1 | 2>();

  for (const item of items) {
    color.set(item.id, 0);
  }

  let cyclePath: string[] | null = null;

  function dfs(nodeId: string, stack: string[]): boolean {
    color.set(nodeId, 1);
    stack.push(nodeId);

    for (const neighbor of adj.get(nodeId) ?? []) {
      if (color.get(neighbor) === 1) {
        // Found a back edge — extract the cycle
        const cycleStart = stack.indexOf(neighbor);
        cyclePath = [...stack.slice(cycleStart), neighbor];
        return true;
      }
      if (color.get(neighbor) === 0) {
        if (dfs(neighbor, stack)) return true;
      }
    }

    stack.pop();
    color.set(nodeId, 2);
    return false;
  }

  for (const item of items) {
    if (color.get(item.id) === 0) {
      if (dfs(item.id, [])) break;
    }
  }

  return cyclePath;
}

/**
 * Assigns wave numbers to work items using Kahn's algorithm (BFS topological sort).
 *
 * Wave number = longest path from any root to this node.
 * Items with no dependencies (or only dangling/unknown dependencies) get wave 0.
 *
 * Throws if circular dependencies are detected.
 */
export function assignWaves(items: WaveSchedulerInput[]): WaveAssignment[] {
  if (items.length === 0) return [];

  // Check for cycles first — provides a descriptive error with the cycle path
  const cycle = detectCircularDependencies(items);
  if (cycle !== null) {
    throw new Error(
      `Circular dependency detected in work item DAG. Cycle: ${cycle.join(" → ")}`
    );
  }

  const knownIds = new Set(items.map((item) => item.id));

  // Build adjacency list and in-degree map, ignoring dangling references
  const inDegree = new Map<string, number>();
  // adj[A] = list of items that depend on A (i.e., A → B means B depends on A)
  const dependents = new Map<string, string[]>();

  for (const item of items) {
    if (!inDegree.has(item.id)) inDegree.set(item.id, 0);
    if (!dependents.has(item.id)) dependents.set(item.id, []);
  }

  for (const item of items) {
    const validDeps = (item.dependsOn ?? []).filter((dep) =>
      knownIds.has(dep)
    );
    inDegree.set(item.id, validDeps.length);
    for (const dep of validDeps) {
      dependents.get(dep)!.push(item.id);
    }
  }

  // Kahn's BFS: start with all nodes that have in-degree 0
  const waveNumbers = new Map<string, number>();
  const queue: string[] = [];

  for (const item of items) {
    if (inDegree.get(item.id) === 0) {
      queue.push(item.id);
      waveNumbers.set(item.id, 0);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentWave = waveNumbers.get(current)!;

    for (const dependentId of dependents.get(current) ?? []) {
      // Update wave number for dependent: max of all dependency waves + 1
      const existingWave = waveNumbers.get(dependentId) ?? 0;
      const proposedWave = currentWave + 1;
      waveNumbers.set(dependentId, Math.max(existingWave, proposedWave));

      // Decrement in-degree; enqueue when all dependencies are processed
      inDegree.set(dependentId, inDegree.get(dependentId)! - 1);
      if (inDegree.get(dependentId) === 0) {
        queue.push(dependentId);
      }
    }
  }

  // Build result array, preserving input order
  return items.map((item) => ({
    workItemId: item.id,
    waveNumber: waveNumbers.get(item.id) ?? 0,
    dependsOn: (item.dependsOn ?? []).filter((dep) => knownIds.has(dep)),
    filesBeingModified: item.filesBeingModified ?? [],
  }));
}
