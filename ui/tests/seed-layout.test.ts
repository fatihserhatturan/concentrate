import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seedLayout, type SeedNode } from "../shared/seed-layout.js";

const make = (groups: Record<string, number>): { nodes: SeedNode[]; groups: Array<{ name: string; count: number }> } => ({
  nodes: Object.entries(groups).flatMap(([group, count]) => Array.from({ length: count }, (_, i) => ({ id: `${group}#${i}`, group, degree: count - i }))),
  groups: Object.entries(groups).map(([name, count]) => ({ name, count })),
});

describe("seedLayout", () => {
  const { nodes, groups } = make({ src: 400, tests: 120, ui: 80, scripts: 10, docs: 1 });

  it("is deterministic and places every node", () => {
    const a = seedLayout(nodes, groups);
    const b = seedLayout([...nodes].reverse(), [...groups].reverse());
    assert.equal(a.positions.size, nodes.length);
    for (const node of nodes) assert.deepEqual(a.positions.get(node.id), b.positions.get(node.id));
  });

  it("keeps the discs of two clusters apart and nodes inside their own disc", () => {
    const { centers, positions } = seedLayout(nodes, groups);
    const list = [...centers.values()];
    for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
      assert.ok(Math.hypot(list[i]!.x - list[j]!.x, list[i]!.y - list[j]!.y) >= list[i]!.radius + list[j]!.radius, "discs do not overlap");
    }
    for (const node of nodes) {
      const center = centers.get(node.group)!;
      const at = positions.get(node.id)!;
      assert.ok(Math.hypot(at.x - center.x, at.y - center.y) <= center.radius, `${node.id} is inside its cluster`);
    }
  });

  it("puts the most connected node of a cluster in its middle", () => {
    const { centers, positions } = seedLayout(nodes, groups);
    const hub = positions.get("src#0")!;
    assert.deepEqual(hub, { x: centers.get("src")!.x, y: centers.get("src")!.y });
  });
});
