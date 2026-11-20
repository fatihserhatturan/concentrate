import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

async function scanSources(files: Record<string, string>): Promise<Graph> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-jpa-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, "src/main/java/app", name)), { recursive: true });
      await writeFile(path.join(dir, "src/main/java/app", name), text);
    }
    return await buildCodeGraph(dir, { continueOnError: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const tables = (graph: Graph) => graph.nodes.filter((node) => node.label === "Table").map((node) => String(node.properties.name)).sort();
const models = (graph: Graph) => graph.nodes.filter((node) => node.label === "DataModel").map((node) => node.id.replace(/^datamodel:/u, "")).sort();
const columnsOf = (graph: Graph, table: string) => (JSON.parse(String(graph.nodes.find((node) => node.label === "Table" && node.properties.name === table)!.properties.columns)) as Array<{ column: string; references?: string; isId: boolean; optional: boolean }>);
function accesses(graph: Graph, direct?: boolean): string[] {
  const names = new Map(graph.nodes.map((node) => [node.id, String(node.properties.name ?? node.id)]));
  return graph.relationships
    .filter((rel) => rel.type === "ACCESSES_DATA" && (direct === undefined || rel.properties.direct === direct) && graph.nodes.find((node) => node.id === rel.from)?.label === "Function")
    .map((rel) => `${names.get(rel.from)} ${rel.properties.operation} ${names.get(rel.to)}`)
    .sort();
}

const ENTITY = (pkg = "jakarta") => `package app;
import ${pkg}.persistence.*;
@Entity
public class Item {
  @Id private Long id;
  private String label;
}
`;

describe("JPA entities and Spring Data (fixtures/java-spring-data-jpa)", () => {
  it("maps entities to tables with columns, relations, inheritance and join tables", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/java-spring-data-jpa"), { continueOnError: false });
    assert.deepEqual(tables(graph), ["card_payment", "catalog_product", "customers", "order_products", "orders", "payment"]);
    assert.deepEqual(columnsOf(graph, "customers").map((column) => column.column), ["id", "created_at", "email_address", "status", "street", "city_name"]);
    assert.equal(graph.nodes.find((node) => node.label === "Table" && node.properties.name === "customers")!.properties.schemaName, "shop");
    const orders = columnsOf(graph, "orders");
    assert.deepEqual(orders.find((column) => column.column === "customer_id"), { name: "customer", column: "customer_id", type: "Customer", optional: true, list: false, isId: false, isUnique: false, references: "customers.id" });
    assert.deepEqual(columnsOf(graph, "order_products").map((column) => [column.column, column.references]), [["order_id", "orders.id"], ["product_id", "catalog_product.id"]]);
    // JOINED: the subclass has its own table with its own fields.
    assert.deepEqual(columnsOf(graph, "card_payment").map((column) => column.column), ["card_last4"]);
    const relations = graph.relationships.filter((rel) => rel.type === "RELATES_TO" && rel.from.startsWith("datamodel:jpa:")).map((rel) => `${rel.from.split(":").at(-1)}.${rel.properties.field} ${rel.properties.kind} -> ${rel.to.split(":").at(-1)} ${rel.properties.fields}`).sort();
    assert.deepEqual(relations, ["Customer.orders many -> Order []", "Order.customer one -> Customer [\"customer_id\"]", "Order.products many -> Product []"]);
    assert.ok(models(graph).includes("spring-data:com.acme.shop.repo:CustomerRepository"));
    assert.ok(graph.relationships.some((rel) => rel.type === "RELATES_TO" && rel.from === "datamodel:spring-data:com.acme.shop.repo:CustomerRepository" && rel.to === "datamodel:jpa:com.acme.shop.domain:Customer" && rel.properties.field === "entity"));
  });

  it("records derived queries, @Query, inherited CRUD and EntityManager calls, reaching routes and tables", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/java-spring-data-jpa"), { continueOnError: false });
    assert.deepEqual(accesses(graph, true), [
      "add create Product",
      "countByStatus aggregate Customer",
      "deleteByStatus delete Customer",
      "existsByEmail read Customer",
      "findByCustomerId read Order",
      "findByEmailAndStatus read Customer",
      "forget delete Customer",
      "forget delete Order",
      "load read Customer",
      "product read Product",
      "products read Product",
      "register upsert Customer",
      "search read Customer",
      "stats read order_products",
      "updateStatus update Customer",
      "withOrders read Customer",
      "withOrders read Order",
    ]);
    // The service method that calls a declared repository method gets it through the call.
    assert.ok(accesses(graph, false).includes("active read Customer"));
    const names = new Map(graph.nodes.map((node) => [node.id, String(node.properties.name ?? node.id)]));
    const routeTables = graph.relationships
      .filter((rel) => (rel.type === "READS" || rel.type === "WRITES") && graph.nodes.find((node) => node.id === rel.from)?.label === "Route")
      .map((rel) => `${rel.type} ${graph.nodes.find((node) => node.id === rel.from)!.properties.path} ${names.get(rel.to)} ${rel.properties.operation}`)
      .sort();
    assert.deepEqual(routeTables, ["READS /customers/{id} customers read", "WRITES /customers customers upsert"]);
    assert.ok(graph.relationships.some((rel) => rel.type === "WRITES" && names.get(rel.from) === "updateStatus" && names.get(rel.to) === "customers"));
    // The plugin's temporary properties never reach the graph.
    assert.ok(!graph.nodes.some((node) => "javaJpaArgs" in node.properties || "javaJpaBases" in node.properties || "javaJpaTransient" in node.properties));
  });
});

describe("JPA entity mapping", () => {
  it("handles javax.persistence, naming, @MappedSuperclass, transient fields and @Table", async () => {
    const graph = await scanSources({
      "Base.java": `package app;
import javax.persistence.*;
@MappedSuperclass public abstract class Base { @Id @GeneratedValue Long id; transient String cache; @Transient String note; static int COUNT; }
`,
      "UserAccount.java": `package app;
import javax.persistence.Entity;
import javax.persistence.Table;
import javax.persistence.Column;
@Entity @Table(name = "Users", schema = "auth") public class UserAccount extends Base { @Column(name = "mail", unique = true) String email; boolean active; }
`,
      "AuditEntry.java": `package app;
import javax.persistence.*;
@Entity(name = "Audit") public class AuditEntry extends Base { String actorName; }
`,
    });
    assert.deepEqual(tables(graph), ["Users", "audit"]);
    assert.deepEqual(columnsOf(graph, "Users").map((column) => column.column), ["id", "mail", "active"]);
    assert.deepEqual(columnsOf(graph, "Users").map((column) => [column.isId, column.optional]), [[true, false], [false, true], [false, false]]);
    assert.deepEqual(columnsOf(graph, "audit").map((column) => column.column), ["id", "actor_name"]);
    assert.deepEqual(models(graph), ["jpa:app:AuditEntry", "jpa:app:UserAccount"]);
  });

  it("puts a SINGLE_TABLE hierarchy in the root's table and gives TABLE_PER_CLASS subclasses their own", async () => {
    const graph = await scanSources({
      "Animal.java": `package app;
import jakarta.persistence.*;
@Entity @Inheritance(strategy = InheritanceType.SINGLE_TABLE) public class Animal { @Id Long id; String name; }
`,
      "Dog.java": `package app;
import jakarta.persistence.*;
@Entity public class Dog extends Animal { String breed; }
`,
      "Shape.java": `package app;
import jakarta.persistence.*;
@Entity @Inheritance(strategy = InheritanceType.TABLE_PER_CLASS) public class Shape { @Id Long id; String color; }
`,
      "Circle.java": `package app;
import jakarta.persistence.*;
@Entity public class Circle extends Shape { double radius; }
`,
    });
    assert.deepEqual(tables(graph), ["animal", "circle", "shape"]);
    assert.deepEqual(columnsOf(graph, "animal").map((column) => column.column), ["id", "name", "breed"]);
    assert.deepEqual(columnsOf(graph, "circle").map((column) => column.column), ["id", "color", "radius"]);
    const mapped = graph.relationships.filter((rel) => rel.type === "MAPS_TO_TABLE").map((rel) => `${rel.from.split(":").at(-1)} ${rel.to.split(":").at(-1)}`).sort();
    assert.deepEqual(mapped, ["Animal animal", "Circle circle", "Dog animal", "Shape shape"]);
  });

  it("ignores an @Entity of another package and leaves other stores' repositories out", async () => {
    const graph = await scanSources({
      "Fake.java": `package app;
import com.other.Entity;
@Entity public class Fake { Long id; }
`,
      "Own.java": `package own;
@interface Entity {}
@Entity class Own { Long id; }
`,
      "Doc.java": `package app;
import org.springframework.data.mongodb.core.mapping.Document;
@Document public class Doc { String id; }
`,
      "DocRepo.java": `package app;
import org.springframework.data.mongodb.repository.MongoRepository;
public interface DocRepo extends MongoRepository<Doc, String> { Doc findByName(String name); }
`,
      "Real.java": ENTITY(),
    });
    assert.deepEqual(tables(graph), ["item"]);
    assert.deepEqual(models(graph), ["jpa:app:Item"]);
  });
});

describe("Spring Data repositories", () => {
  const REPOS: Record<string, string> = {
    "Item.java": ENTITY(),
    "Other.java": `package app;
import jakarta.persistence.*;
@Entity @Table(name = "others") public class Other { @Id Long id; }
`,
    "Names.java": `package app;
public final class Names { static final String BY_LABEL = "select i from Item i where i.label = :l"; }
`,
    "Base.java": `package app;
import org.springframework.data.repository.*;
public interface Base<T, K> extends CrudRepository<T, K> {}
`,
    "ItemRepo.java": `package app;
import java.util.List;
import org.springframework.data.jpa.repository.*;
public interface ItemRepo extends Base<Item, Long> {
  List<Item> findByLabel(String label);
  long countByLabel(String label);
  void removeByLabel(String label);
  int getByteSize();
  @Query(Names.BY_LABEL) List<Item> byLabel(String l);
  @Query("select count(i) from Item i join Other o on 1 = 1") long counts();
  @Query(value = "update others set id = id", nativeQuery = true) @Modifying int touch();
  @Query("delete from Item i where i.label = ?1") @Modifying void purge(String l);
  @Query("select o from Other o") List<Other> others();
  @Query("select x from Missing x") List<Item> missing();
}
`,
    "Svc.java": `package app;
import org.springframework.stereotype.Service;
@Service public class Svc {
  private final ItemRepo repo;
  private final Unknown other;
  Svc(ItemRepo repo, Unknown other) { this.repo = repo; this.other = other; }
  void write(Item item) { repo.save(item); }
  void read() { repo.findAll(); repo.findById(1L); repo.count(); repo.existsById(1L); }
  void drop() { repo.deleteAll(); }
  void notRepo() { other.save(null); other.findAll(); }
  void viaDeclared() { repo.findByLabel("x"); }
}
`,
  };

  it("finds entities through generic user base interfaces and records every kind of access", async () => {
    const graph = await scanSources(REPOS);
    assert.deepEqual(models(graph).filter((model) => model.startsWith("spring-data")), ["spring-data:app:ItemRepo"]);
    const direct = accesses(graph, true);
    assert.deepEqual(direct, [
      "byLabel read Item",
      "countByLabel aggregate Item",
      "counts aggregate Item",
      "counts read Other",
      "drop delete Item",
      "findByLabel read Item",
      "purge delete Item",
      "read aggregate Item",
      "read read Item",
      "read read Item",
      "read read Item",
      "removeByLabel delete Item",
      "others read Other",
      "touch update Other",
      "write upsert Item",
    ].sort());
    assert.ok(accesses(graph, false).includes("viaDeclared read Item"));
    // `getByteSize` is no derived query, `Missing` is no entity, and `Unknown` is no repository.
    assert.ok(!direct.some((entry) => entry.startsWith("getByteSize") || entry.startsWith("missing") || entry.startsWith("notRepo")));
  });

  it("does not take a user's own JpaRepository type for Spring Data", async () => {
    const graph = await scanSources({
      "Item.java": ENTITY(),
      "JpaRepository.java": `package app;
public interface JpaRepository<T, K> {}
`,
      "ItemRepo.java": `package app;
public interface ItemRepo extends JpaRepository<Item, Long> { Item findByLabel(String l); }
`,
    });
    assert.deepEqual(models(graph), ["jpa:app:Item"]);
    assert.deepEqual(accesses(graph), []);
  });
});

describe("EntityManager and Session calls", () => {
  it("records persist, merge, remove, find and queries of an injected EntityManager", async () => {
    const graph = await scanSources({
      "Item.java": ENTITY("javax"),
      "Svc.java": `package app;
import javax.persistence.EntityManager;
import javax.persistence.PersistenceContext;
public class Svc {
  private static final String Q = "select i from Item i where i.id > 0";
  @PersistenceContext private EntityManager em;
  void a(Item item) { em.persist(item); em.merge(item); em.remove(item); }
  Item b(Long id) { return em.find(Item.class, id); }
  void c() { em.createQuery(Q); }
  void d() { String sql = "delete from item"; em.createNativeQuery(sql).executeUpdate(); }
  void e() { Item fresh = new Item(); em.persist(new Item()); }
  void f(Object anything) { em.persist(anything); em.createQuery("select z from Zed z"); }
}
`,
      "Fake.java": `package app;
import com.other.EntityManager;
public class Fake { private EntityManager em; void a(Item item) { em.persist(item); } }
`,
    });
    assert.deepEqual(accesses(graph, true), [
      "a create Item",
      "a delete Item",
      "a upsert Item",
      "b read Item",
      "c read Item",
      "d delete Item",
      "e create Item",
    ]);
  });
});
