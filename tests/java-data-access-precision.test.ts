import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

// Phase 43 (#283), W2-DATA: data-access precision on Java.

// `function: model:operation:library` of the direct accesses, and the ids of the DataModel nodes.
async function scan(files: Record<string, string>): Promise<{ accesses: string[]; models: string[] }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-precision-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), text);
    }
    const result = await buildCodeGraph(dir, { continueOnError: true, concurrency: 1, workers: 0 });
    const names = new Map(result.nodes.map((node) => [node.id, String(node.properties.name)]));
    return {
      accesses: result.relationships
        .filter((rel) => rel.type === "ACCESSES_DATA" && rel.properties.direct === true)
        .map((rel) => `${names.get(rel.from)}: ${names.get(rel.to)}:${String(rel.properties.operation)}:${String(rel.properties.library)}`)
        .sort(),
      models: result.nodes.filter((node) => node.label === "DataModel").map((node) => node.id).sort(),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ENTITY = `package com.acme;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
@Entity public class Owner { @Id Integer id; }
`;

describe("Java data access precision", () => {
  it("does not run the JS/TS ORM heuristic on Java files", async () => {
    const { accesses, models } = await scan({
      "src/ArticleApi.java": `package com.acme;
public class ArticleApi {
  private ArticleRepository articleRepository;
  public void delete(Article article) { articleRepository.remove(article); articleRepository.save(article); articleRepository.find("x"); }
}
class Article {}
class ArticleRepository { void remove(Article a) {} void save(Article a) {} Object find(String s) { return null; } }
`,
    });
    assert.deepEqual(accesses, []);
    assert.deepEqual(models.filter((id) => id.startsWith("datamodel:typeorm:")), []);
  });

  it("does not count a merge that only re-attaches an entity removed next as a write", async () => {
    const { accesses } = await scan({
      "src/Owner.java": ENTITY,
      "src/Repo.java": `package com.acme;
import jakarta.persistence.EntityManager;
public class Repo {
  private EntityManager em;
  public void delete(Owner owner) { this.em.remove(this.em.contains(owner) ? owner : this.em.merge(owner)); }
  public void direct(Owner owner) { em.remove(em.merge(owner)); }
  public void save(Owner owner) { em.merge(owner); }
}
`,
    });
    assert.deepEqual(accesses, ["delete: Owner:delete:jpa", "direct: Owner:delete:jpa", "save: Owner:upsert:jpa"]);
  });

  it("attributes SimpleJdbcInsert creates to the method that runs the insert, not the constructor", async () => {
    const { accesses } = await scan({
      "src/Dao.java": `package com.acme;
import java.util.Map;
import javax.sql.DataSource;
import org.springframework.jdbc.core.simple.SimpleJdbcInsert;
public class Dao {
  private SimpleJdbcInsert insertOwner;
  private final SimpleJdbcInsert insertType = new SimpleJdbcInsert((DataSource) null).withTableName("types");
  public Dao(DataSource ds) { this.insertOwner = new SimpleJdbcInsert(ds).withTableName("owners").usingGeneratedKeyColumns("id"); }
  public void save(Map<String, Object> row) { insertOwner.executeAndReturnKey(row); }
  public void saveType(Map<String, Object> row) { this.insertType.execute(row); }
  public void local(DataSource ds, Map<String, Object> row) { SimpleJdbcInsert i = new SimpleJdbcInsert(ds).withTableName("locals"); i.execute(row); }
}
`,
    });
    assert.deepEqual(accesses, ["local: locals:create:jdbc", "save: owners:create:jdbc", "saveType: types:create:jdbc"]);
  });

  it("reads SELECT COUNT(...) as an aggregate and other selects as reads", async () => {
    const { accesses } = await scan({
      "src/Dao.java": `package com.acme;
import org.springframework.jdbc.core.JdbcTemplate;
public class Dao {
  private JdbcTemplate jdbc;
  public Long total() { return jdbc.queryForObject("SELECT COUNT(*) FROM owners WHERE last_name LIKE ?", Long.class, "a"); }
  public Long distinct() { return jdbc.queryForObject("select count(distinct id) as n from pets", Long.class); }
  public Object rows() { return jdbc.queryForList("SELECT id, COUNT(*) FROM visits GROUP BY id"); }
}
`,
    });
    assert.deepEqual(accesses, ["distinct: pets:aggregate:jdbc", "rows: visits:read:jdbc", "total: owners:aggregate:jdbc"]);
  });
});
