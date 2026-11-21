import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { scanCalls, scanDataAccess, scanImports, scanInjections } from "../scripts/accuracy/compare.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

async function project(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "java-measurement-"));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), text);
  }
  return directory;
}

const graphOf = async (files: Record<string, string>) => buildCodeGraph(await project(files), { continueOnError: false });
const TODO = { todo: "wave 2 fix" };

// Fixes found by the Phase 43 measurement of the Java samples get a regression
// test here, one `it` per fix, the way tests/cpp-measurement.test.ts does.
// Tests marked `todo` pin a rule a parallel wave-2 track implements.
describe("Java measurement fixes (Phase 43)", () => {
  it("resolves an import to its file and injects a constructor dependency", async () => {
    const root = await project({
      "src/main/java/app/Repo.java": `package app;
import org.springframework.stereotype.Repository;
@Repository
public class Repo {}
`,
      "src/main/java/app/Service.java": `package app;
import org.springframework.stereotype.Service;
import app.Repo;
@Service
public class Service {
  private final Repo repo;
  public Service(Repo repo) { this.repo = repo; }
}
`,
    });
    const graph = await buildCodeGraph(root, { continueOnError: false });
    assert.ok(graph.relationships.some((rel) => rel.type === "RESOLVES_TO" && rel.from.includes(":import:") && rel.to === "file:src/main/java/app/Repo.java"));
    const injects = graph.relationships.filter((rel) => rel.type === "INJECTS");
    assert.equal(injects.length, 1);
    assert.equal(injects[0]!.properties.via, "constructor");
  });

  it("resolves a call through an interface to the interface method and every implementer", async () => {
    const graph = await graphOf({
      "src/main/java/app/Store.java": `package app;
public interface Store { void save(String x); }
`,
      "src/main/java/app/FileStore.java": `package app;
public class FileStore implements Store { public void save(String x) {} }
`,
      "src/main/java/app/MemoryStore.java": `package app;
public class MemoryStore implements Store { public void save(String x) {} }
`,
      "src/main/java/app/Service.java": `package app;
public class Service {
  private final Store store;
  public Service(Store store) { this.store = store; }
  public void run() { store.save("a"); }
}
`,
    });
    const call = scanCalls(graph, ["src/main/java/app/Service.java"]).find((item) => item.callee === "save");
    assert.ok(call);
    const targets = call.targets.map((target) => `${target.className}.${target.name}`).sort();
    assert.deepEqual(targets, ["FileStore.save", "MemoryStore.save", "Store.save"]);
  });

  it("leaves a wildcard import unresolved", TODO, async () => {
    const graph = await graphOf({
      "src/main/java/app/model/Pet.java": `package app.model;
public class Pet {}
`,
      "src/main/java/app/Use.java": `package app;
import app.model.*;
public class Use { Pet pet; }
`,
    });
    const wildcard = scanImports(graph).find((item) => item.file === "src/main/java/app/Use.java" && item.source === "app.model.*");
    assert.ok(wildcard);
    assert.equal(wildcard.target, null);
  });

  it("counts em.remove(em.merge(x)) as a delete only", TODO, async () => {
    const graph = await graphOf({
      "src/main/java/app/Pet.java": `package app;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
@Entity
@Table(name = "pets")
public class Pet { @Id Integer id; }
`,
      "src/main/java/app/PetRepo.java": `package app;
import jakarta.persistence.EntityManager;
import jakarta.persistence.PersistenceContext;
import org.springframework.stereotype.Repository;
@Repository
public class PetRepo {
  @PersistenceContext private EntityManager em;
  public void delete(Pet pet) { this.em.remove(this.em.contains(pet) ? pet : this.em.merge(pet)); }
  public void drop(Pet pet) { em.remove(em.merge(pet)); }
}
`,
    });
    const accesses = scanDataAccess(graph).filter((item) => item.file === "src/main/java/app/PetRepo.java");
    for (const name of ["delete", "drop"]) {
      assert.deepEqual(accesses.filter((item) => item.function === name).map((item) => item.operation).sort(), ["delete"], name);
    }
  });

  it("attributes a SimpleJdbcInsert create to the method that executes it", TODO, async () => {
    const graph = await graphOf({
      "src/main/java/app/OwnerRepo.java": `package app;
import javax.sql.DataSource;
import java.util.Map;
import org.springframework.jdbc.core.simple.SimpleJdbcInsert;
import org.springframework.stereotype.Repository;
@Repository
public class OwnerRepo {
  private final SimpleJdbcInsert insertOwner;
  public OwnerRepo(DataSource dataSource) {
    this.insertOwner = new SimpleJdbcInsert(dataSource).withTableName("owners").usingGeneratedKeyColumns("id");
  }
  public void save(Map<String, Object> owner) { insertOwner.executeAndReturnKey(owner); }
}
`,
    });
    const creates = scanDataAccess(graph).filter((item) => item.operation === "create" && item.table === "owners");
    assert.deepEqual(creates.map((item) => item.function), ["save"]);
  });

  it("counts a JDBC COUNT query as an aggregate", TODO, async () => {
    const graph = await graphOf({
      "src/main/java/app/OwnerRepo.java": `package app;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
@Repository
public class OwnerRepo {
  private final JdbcTemplate jdbc;
  public OwnerRepo(JdbcTemplate jdbc) { this.jdbc = jdbc; }
  public int total() { return jdbc.queryForObject("SELECT COUNT(*) FROM owners", Integer.class); }
}
`,
    });
    const accesses = scanDataAccess(graph).filter((item) => item.function === "total");
    assert.deepEqual(accesses.map((item) => `${item.table}:${item.operation}`), ["owners:aggregate"]);
  });

  it("injects every profile-gated candidate of an interface", TODO, async () => {
    const graph = await graphOf({
      "src/main/java/app/Greeter.java": `package app;
public interface Greeter {}
`,
      "src/main/java/app/DevGreeter.java": `package app;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;
@Service
@Profile("dev")
public class DevGreeter implements Greeter {}
`,
      "src/main/java/app/ProdGreeter.java": `package app;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;
@Service
@Profile("prod")
public class ProdGreeter implements Greeter {}
`,
      "src/main/java/app/Consumer.java": `package app;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
@Service
public class Consumer {
  @Autowired private Greeter greeter;
}
`,
    });
    const providers = scanInjections(graph).filter((item) => item.consumer === "app.Consumer").map((item) => item.provider).sort();
    assert.deepEqual(providers, ["app.DevGreeter", "app.ProdGreeter"]);
  });

  it("injects the fields of a ConstraintValidator the container autowires", TODO, async () => {
    const graph = await graphOf({
      "src/main/java/app/UserRepo.java": `package app;
import org.springframework.stereotype.Repository;
@Repository
public class UserRepo {}
`,
      "src/main/java/app/Unique.java": `package app;
import jakarta.validation.Constraint;
@Constraint(validatedBy = UniqueValidator.class)
public @interface Unique {}
`,
      "src/main/java/app/UniqueValidator.java": `package app;
import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;
import org.springframework.beans.factory.annotation.Autowired;
public class UniqueValidator implements ConstraintValidator<Unique, String> {
  @Autowired private UserRepo repo;
  public boolean isValid(String value, ConstraintValidatorContext context) { return repo != null; }
}
`,
    });
    const injected = scanInjections(graph).filter((item) => item.consumer === "app.UniqueValidator");
    assert.deepEqual(injected.map((item) => `${item.field} -> ${item.provider}`), ["repo -> app.UserRepo"]);
  });
});
