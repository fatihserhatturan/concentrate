import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

async function scan(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-count-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, "src/main/java/app", name)), { recursive: true });
      await writeFile(path.join(dir, "src/main/java/app", name), text);
    }
    const graph = await buildCodeGraph(dir, { continueOnError: false });
    const names = new Map(graph.nodes.map((node) => [node.id, String(node.properties.name ?? node.id)]));
    return graph.relationships
      .filter((rel) => rel.type === "ACCESSES_DATA" && graph.nodes.find((node) => node.id === rel.from)?.label === "Function")
      .map((rel) => `${names.get(rel.from)} ${rel.properties.operation} ${names.get(rel.to)}`)
      .sort();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ENTITY = `package app;
import jakarta.persistence.*;
@Entity
@Table(name = "items")
public class Item { @Id private Long id; private String label; }
`;

describe("Spring Data @Query countQuery", () => {
  it("reads a JPQL countQuery as an aggregate of the same method", async () => {
    const found = await scan({
      "Item.java": ENTITY,
      "ItemRepository.java": `package app;
import org.springframework.data.jpa.repository.*;
import org.springframework.data.domain.*;
public interface ItemRepository extends JpaRepository<Item, Long> {
  @Query(value = "SELECT i FROM Item i WHERE i.label = ?1", countQuery = "SELECT COUNT(i) FROM Item i WHERE i.label = ?1")
  Page<Item> findByLabel(String label, Pageable p);
}
`,
    });
    assert.deepEqual(found.filter((line) => line.startsWith("findByLabel")), ["findByLabel aggregate Item", "findByLabel read Item"]);
  });

  it("reads a native countQuery", async () => {
    const found = await scan({
      "Item.java": ENTITY,
      "ItemRepository.java": `package app;
import org.springframework.data.jpa.repository.*;
import org.springframework.data.domain.*;
public interface ItemRepository extends JpaRepository<Item, Long> {
  @Query(value = "SELECT * FROM items", countQuery = "SELECT COUNT(*) FROM items", nativeQuery = true)
  Page<Item> everything(Pageable p);
}
`,
    });
    assert.deepEqual(found.filter((line) => line.startsWith("everything")), ["everything aggregate Item", "everything read Item"]);
  });
});
