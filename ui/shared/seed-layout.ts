// Where nodes start before a force layout runs. Clusters (folders) get their own
// disc, placed so that no two overlap; inside a disc the most connected nodes sit
// in the middle. Pure and deterministic: the same graph gives the same picture.

export type SeedNode = { id: string; group: string; degree: number };
export type SeedGroup = { name: string; count: number };
export type Placed = { x: number; y: number };
export type SeedResult = { positions: Map<string, Placed>; centers: Map<string, Placed & { radius: number }> };

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** Disc radius per node: phyllotaxis puts node i at SPACING * sqrt(i). */
const SPACING = 7.5;
const GAP = 90;

export function seedLayout(nodes: readonly SeedNode[], groups: readonly SeedGroup[]): SeedResult {
  const centers = new Map<string, Placed & { radius: number }>();
  const ordered = [...groups].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const placed: Array<Placed & { radius: number }> = [];
  for (const group of ordered) {
    const radius = SPACING * Math.sqrt(group.count) + 8;
    let spot: Placed = { x: 0, y: 0 };
    if (placed.length > 0) {
      // Walk outwards along a spiral until the disc fits.
      for (let step = 1; ; step += 1) {
        const distance = 12 * Math.sqrt(step) * 4;
        const angle = step * GOLDEN;
        spot = { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
        if (placed.every((other) => Math.hypot(other.x - spot.x, other.y - spot.y) >= other.radius + radius + GAP)) break;
      }
    }
    const center = { ...spot, radius };
    placed.push(center);
    centers.set(group.name, center);
  }

  const byGroup = new Map<string, SeedNode[]>();
  for (const node of nodes) (byGroup.get(node.group) ?? byGroup.set(node.group, []).get(node.group)!).push(node);
  const positions = new Map<string, Placed>();
  for (const [name, members] of byGroup) {
    const center = centers.get(name) ?? { x: 0, y: 0, radius: 0 };
    members.sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id)).forEach((node, i) => {
      const r = SPACING * Math.sqrt(i);
      positions.set(node.id, { x: center.x + Math.cos(i * GOLDEN) * r, y: center.y + Math.sin(i * GOLDEN) * r });
    });
  }
  return { positions, centers };
}
