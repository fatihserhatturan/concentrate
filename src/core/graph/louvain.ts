// Louvain community detection on a weighted undirected graph, written here
// to keep the dependency count at one. Deterministic: nodes are visited in
// index order and ties go to the lowest community, so one graph always
// yields one partition.

type Adjacency = Array<Map<number, number>>;

export function louvain(nodeCount: number, edges: ReadonlyArray<readonly [number, number, number]>): number[] {
  let adjacency: Adjacency = Array.from({ length: nodeCount }, () => new Map());
  let loops = new Array<number>(nodeCount).fill(0);
  for (const [a, b, weight] of edges) {
    if (a === b) loops[a]! += weight;
    else {
      adjacency[a]!.set(b, (adjacency[a]!.get(b) ?? 0) + weight);
      adjacency[b]!.set(a, (adjacency[b]!.get(a) ?? 0) + weight);
    }
  }

  // membership[original node] = community at the current level.
  let membership = Array.from({ length: nodeCount }, (_, index) => index);
  for (let level = 0; level < 20; level += 1) {
    const { community, moved } = localMoves(adjacency, loops);
    if (!moved) break;
    // Renumber communities by first appearance, then fold each into one node.
    const renumber = new Map<number, number>();
    for (const c of community) if (!renumber.has(c)) renumber.set(c, renumber.size);
    const folded: Adjacency = Array.from({ length: renumber.size }, () => new Map());
    const foldedLoops = new Array<number>(renumber.size).fill(0);
    adjacency.forEach((neighbors, node) => {
      const from = renumber.get(community[node]!)!;
      foldedLoops[from]! += loops[node]!;
      for (const [other, weight] of neighbors) {
        const to = renumber.get(community[other]!)!;
        if (from === to) {
          // Each internal pair is seen from both ends: count it once.
          if (node < other) foldedLoops[from]! += weight;
        } else {
          folded[from]!.set(to, (folded[from]!.get(to) ?? 0) + weight);
        }
      }
    });
    membership = membership.map((c) => renumber.get(community[c]!)!);
    adjacency = folded;
    loops = foldedLoops;
  }
  return membership;
}

function localMoves(adjacency: Adjacency, loops: number[]): { community: number[]; moved: boolean } {
  const count = adjacency.length;
  const degree = adjacency.map((neighbors, node) => {
    let sum = 2 * loops[node]!;
    for (const weight of neighbors.values()) sum += weight;
    return sum;
  });
  const twoM = degree.reduce((sum, value) => sum + value, 0);
  const community = Array.from({ length: count }, (_, index) => index);
  if (twoM === 0) return { community, moved: false };
  const total = [...degree];

  let moved = false;
  for (let pass = 0; pass < 50; pass += 1) {
    let changed = false;
    for (let node = 0; node < count; node += 1) {
      const own = community[node]!;
      const weights = new Map<number, number>();
      for (const [other, weight] of adjacency[node]!) {
        weights.set(community[other]!, (weights.get(community[other]!) ?? 0) + weight);
      }
      total[own]! -= degree[node]!;
      const gain = (candidate: number) => (weights.get(candidate) ?? 0) - (total[candidate]! * degree[node]!) / twoM;
      let best = own;
      let bestGain = gain(own);
      for (const candidate of [...weights.keys()].sort((a, b) => a - b)) {
        const value = gain(candidate);
        if (value > bestGain + 1e-12) {
          best = candidate;
          bestGain = value;
        }
      }
      total[best]! += degree[node]!;
      if (best !== own) {
        community[node] = best;
        changed = true;
        moved = true;
      }
    }
    if (!changed) break;
  }
  return { community, moved };
}
