import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { GraphBuilder } from "../src/core/graph/builder.js";
import { createScanReport } from "../src/core/scan/report.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { javaDataJdbcContributor } from "../src/integrations/frameworks/java/data-jdbc.js";
import { javaFrameworkParser } from "../src/integrations/frameworks/java/index.js";
import { mapperStatements, readMapperFile } from "../src/integrations/frameworks/java/mybatis-xml.js";

async function withProject<T>(files: Record<string, string>, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-jdbc-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), text);
    }
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// `function: table:operation:library` of the direct accesses of a scan.
async function directAccesses(files: Record<string, string>): Promise<string[]> {
  return withProject(files, async (dir) => {
    const result = await buildCodeGraph(dir, { continueOnError: true, concurrency: 1, workers: 0 });
    const names = new Map(result.nodes.map((node) => [node.id, String(node.properties.name)]));
    return result.relationships
      .filter((rel) => rel.type === "ACCESSES_DATA" && rel.properties.direct === true)
      .map((rel) => `${names.get(rel.from)}: ${names.get(rel.to)}:${String(rel.properties.operation)}:${String(rel.properties.library)}`)
      .sort();
  });
}

// The contributor over parser output (a finished scan drops the calls nothing resolves).
async function contributorAccesses(files: Record<string, string>): Promise<string[]> {
  return withProject(files, async (dir) => {
    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    for (const name of Object.keys(files).filter((file) => file.endsWith(".java"))) {
      const parsed = await javaFrameworkParser.parse(dir, path.join(dir, name));
      nodes.push(...parsed.nodes);
      relationships.push(...parsed.relationships);
    }
    const graph = new GraphBuilder();
    graph.addNodes(nodes);
    graph.addRelationships(relationships);
    await javaDataJdbcContributor.contribute(graph, dir, createScanReport(0, 0), Object.keys(files).map((file) => path.join(dir, file)), { apiOrigins: [] });
    const names = new Map(graph.nodes.map((node) => [node.id, String(node.properties.name)]));
    return graph.relationshipsOfType("ACCESSES_DATA").map((rel) => `${names.get(rel.from)}: ${names.get(rel.to)}:${String(rel.properties.operation)}`).sort();
  });
}

const dao = (imports: string, body: string, fields = "private final JdbcTemplate jdbc;") => `package com.acme;
${imports}
public class Dao {
  ${fields}
  ${body}
}
`;
const JDBC = "import org.springframework.jdbc.core.JdbcTemplate;";

describe("Java JDBC data access", () => {
  it("reads the SQL of JdbcTemplate calls, constants, locals and text blocks", async () => {
    const accesses = await contributorAccesses({
      "src/Consts.java": `package com.acme; public class Consts { public static final String T = "orders"; public static final String Q = "SELECT * FROM " + T + " WHERE id = ?"; }`,
      "src/Dao.java": dao(JDBC, `
  void a() { jdbc.queryForObject(Consts.Q, Long.class, 1L); }
  void b() { String s = "DELETE FROM sessions WHERE x < ?"; jdbc.update(s); }
  void c() { jdbc.execute("""
      INSERT INTO audit (a)
      VALUES (1)
      """); }
  void d() { jdbc.batchUpdate("UPDATE users SET a = ?", java.util.List.of()); }
  void e() { jdbc.queryForList("SELECT " + "x" + " FROM people JOIN pets ON 1 = 1"); }`),
    });
    assert.deepEqual(accesses, [
      "a: orders:read", "b: sessions:delete", "c: audit:create", "d: users:update", "e: people:read", "e: pets:read",
    ].sort());
  });

  it("identifies the receiver's type: fully qualified, wildcard-imported, interface and constructed receivers", async () => {
    const accesses = await contributorAccesses({
      "src/Dao.java": `package com.acme;
import org.springframework.jdbc.core.*;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
public class Dao {
  private final NamedParameterJdbcTemplate named;
  private final org.springframework.jdbc.core.JdbcOperations ops;
  private final JdbcClient client;
  Dao(NamedParameterJdbcTemplate named, org.springframework.jdbc.core.JdbcOperations ops, JdbcClient client) { this.named = named; this.ops = ops; this.client = client; }
  void a() { named.query("SELECT * FROM n1", (rs, i) -> i); }
  void b() { ops.update("UPDATE n2 SET a = 1"); }
  void c() { client.sql("SELECT * FROM n3").query(Long.class); }
  void d(JdbcTemplate t) { t.queryForRowSet("SELECT * FROM n4"); }
  void e() { new JdbcTemplate().update("DELETE FROM n5"); }
  void f() { var local = new JdbcTemplate(); local.query("SELECT * FROM n6", (rs, i) -> i); }
}
`,
    });
    assert.deepEqual(accesses, ["a: n1:read", "b: n2:update", "c: n3:read", "d: n4:read", "e: n5:delete", "f: n6:read"]);
  });

  it("reads plain JDBC: prepareStatement, prepareCall, Statement and SimpleJdbcInsert", async () => {
    const accesses = await contributorAccesses({
      "src/Dao.java": `package com.acme;
import java.sql.*;
import org.springframework.jdbc.core.simple.SimpleJdbcInsert;
public class Dao {
  void a(Connection c) throws SQLException { try (PreparedStatement ps = c.prepareStatement("INSERT INTO p1 (a) VALUES (?)")) { ps.executeUpdate(); } }
  void b(Connection c) throws SQLException { CallableStatement cs = c.prepareCall("{call refresh(?)}"); cs.execute(); }
  void c(Statement s) throws SQLException { s.executeQuery("SELECT * FROM p3"); s.addBatch("UPDATE p4 SET a = 1"); }
  void d(javax.sql.DataSource ds) { new SimpleJdbcInsert(ds).withTableName("p5").execute(java.util.Map.of()); }
}
`,
    });
    assert.deepEqual(accesses, ["a: p1:create", "c: p3:read", "c: p4:update", "d: p5:create"]);
  });

  it("ignores user classes with query/update methods, other receiver types and non-literal SQL", async () => {
    const accesses = await contributorAccesses({
      "src/Search.java": `package com.acme;
public class Search {
  Object query(String text) { return null; }
  void run() { query("SELECT * FROM documents"); this.query("SELECT * FROM documents2"); }
}
`,
      "src/JdbcTemplate.java": `package com.acme; public class JdbcTemplate { void update(String sql) {} }`,
      "src/Own.java": `package com.acme;
import java.util.Map;
public class Own {
  private final JdbcTemplate jdbc = new JdbcTemplate();
  private final Map<String, String> map = null;
  void a() { jdbc.update("DELETE FROM own_table"); }
  void b() { map.get("SELECT * FROM mapped"); }
  void c(org.hibernate.Session s) { s.createQuery("SELECT * FROM hibernate"); s.execute("DELETE FROM x"); }
}
`,
      "src/Dao.java": dao(JDBC, `
  void a(String sql) { jdbc.update(sql); }
  void b(String table) { jdbc.update("DELETE FROM " + table); }
  void c() { jdbc.query(con -> con.prepareStatement("SELECT 1"), (rs, i) -> i); }
  void d() { var unknown = jdbc(); unknown.update("DELETE FROM unknown"); }
  Object jdbc() { return null; }
  void e() { String s = "DELETE FROM first"; s = "DELETE FROM second"; jdbc.update(s); }`),
    });
    assert.deepEqual(accesses, []);
  });

  it("propagates to the route that calls the DAO", async () => {
    const accesses = await withProject({
      "src/main/java/com/acme/UserDao.java": dao(JDBC, `public Object find() { return jdbc.queryForObject("SELECT name FROM users", String.class); }`),
      "src/main/java/com/acme/UserController.java": `package com.acme;
import org.springframework.web.bind.annotation.*;
@RestController
public class UserController {
  private final Dao dao;
  UserController(Dao dao) { this.dao = dao; }
  @GetMapping("/users") public Object list() { return dao.find(); }
}
`,
    }, async (dir) => {
      const result = await buildCodeGraph(dir, { continueOnError: true, concurrency: 1, workers: 0 });
      const route = result.nodes.find((node) => node.label === "Route")!;
      return result.relationships.filter((rel) => rel.from === route.id && ["ACCESSES_DATA", "READS"].includes(rel.type)).map((rel) => `${rel.type}:${String(result.nodes.find((n) => n.id === rel.to)!.properties.name)}`).sort();
    });
    assert.deepEqual(accesses, ["ACCESSES_DATA:users", "READS:users"]);
  });
});

describe("MyBatis mapper XML", () => {
  it("strips dynamic tags, resolves includes, reads CDATA and entities", () => {
    const file = readMapperFile(`<?xml version="1.0"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="a.B">
  <sql id="cols">id, name</sql>
  <sql id="nested">FROM <include refid="tbl"/></sql>
  <sql id="tbl">accounts</sql>
  <sql id="loop"><include refid="loop"/> x</sql>
  <select id="find">SELECT <include refid="cols"/> <include refid="nested"/>
    <where><if test="id != null and id &gt; 0">id = #{id}</if><if test="a &lt; b">AND x = \${col}</if></where>
    <choose><when test="x">AND y IN (SELECT y FROM other)</when><otherwise>AND z = 1</otherwise></choose></select>
  <insert id="add"><![CDATA[INSERT INTO accounts (a) SELECT a FROM src WHERE a < 3]]></insert>
  <update id="touch">UPDATE <include refid="a.B.tbl"/> <set>a = 1,</set> WHERE a &lt;= 4</update>
  <delete id="loops">DELETE FROM t <include refid="loop"/></delete>
  <resultMap id="ignored" type="x"><id column="id"/></resultMap>
</mapper>`)!;
    const [mapper] = mapperStatements([file]);
    assert.equal(mapper!.namespace, "a.B");
    const byId = Object.fromEntries(mapper!.statements.map((statement) => [statement.id, statement]));
    assert.equal(byId.find!.sql, "SELECT id, name FROM accounts id = ? AND x = ? AND y IN (SELECT y FROM other) AND z = 1");
    assert.equal(byId.add!.sql, "INSERT INTO accounts (a) SELECT a FROM src WHERE a < 3");
    assert.equal(byId.touch!.sql, "UPDATE accounts a = 1, WHERE a <= 4");
    assert.equal(byId.loops!.sql, "DELETE FROM t x");
    assert.equal(byId.find!.line, 8);
    assert.deepEqual(Object.keys(byId), ["find", "add", "touch", "loops"]);
  });

  it("is not a mapper without a namespace root", () => {
    assert.equal(readMapperFile(`<configuration><select id="x">SELECT * FROM logs</select></configuration>`), null);
    assert.equal(readMapperFile(`<mapper><select id="x">SELECT 1</select></mapper>`), null);
    assert.equal(readMapperFile("plain text"), null);
  });
});

describe("MyBatis data access", () => {
  const mapper = `package com.acme;
import java.util.List;
import org.apache.ibatis.annotations.*;
@Mapper
public interface UserMapper {
  String T = "users";
  @Select("SELECT * FROM " + T + " WHERE id = #{id}") Object byId(long id);
  @Select({"SELECT r.name", "FROM roles r", "JOIN grants g ON g.role = r.id"}) List<String> roles();
  @Insert("INSERT INTO users (name) VALUES (#{name})") int add(String name);
  @Delete("""
      DELETE FROM users WHERE id = #{id}
      """) int remove(long id);
  @SelectProvider(type = Sql.class, method = "x") Object provided();
  Object inXml(String q);
  Object nothing();
}
`;

  it("reads annotated statements and the XML statements of the namespace's interface", async () => {
    const accesses = await directAccesses({
      "src/main/java/com/acme/UserMapper.java": mapper,
      "src/main/resources/UserMapper.xml": `<mapper namespace="com.acme.UserMapper">
  <select id="inXml">SELECT * FROM xml_table <if test="q != null">WHERE q = #{q}</if></select>
  <select id="missing">SELECT * FROM ghost</select>
</mapper>`,
      "src/main/resources/Other.xml": `<mapper namespace="com.acme.NotScanned"><select id="inXml">SELECT * FROM other</select></mapper>`,
      "src/main/resources/logback.xml": `<configuration><select id="inXml">SELECT * FROM logs</select></configuration>`,
    });
    assert.deepEqual(accesses, [
      "add: users:create:mybatis",
      "byId: users:read:mybatis",
      "inXml: xml_table:read:mybatis",
      "remove: users:delete:mybatis",
      "roles: grants:read:mybatis",
      "roles: roles:read:mybatis",
    ]);
  });

  it("propagates through the service and route that call a mapper method", async () => {
    await withProject({
      "src/main/java/com/acme/UserMapper.java": mapper,
      "src/main/java/com/acme/UserController.java": `package com.acme;
import org.springframework.web.bind.annotation.*;
@RestController
public class UserController {
  private final UserMapper users;
  UserController(UserMapper users) { this.users = users; }
  @GetMapping("/users/{id}") public Object get(@PathVariable long id) { return users.byId(id); }
  @PostMapping("/users") public int add() { return users.add("x"); }
}
`,
    }, async (dir) => {
      const result = await buildCodeGraph(dir, { continueOnError: true, concurrency: 1, workers: 0 });
      const routes = result.nodes.filter((node) => node.label === "Route");
      const found = routes.map((route) => `${String(route.properties.method)} ${String(route.properties.path)}: ${result.relationships
        .filter((rel) => rel.from === route.id && (rel.type === "READS" || rel.type === "WRITES"))
        .map((rel) => `${rel.type}:${String(result.nodes.find((node) => node.id === rel.to)!.properties.name)}`).sort().join(",")}`).sort();
      assert.deepEqual(found, ["GET /users/{id}: READS:users", "POST /users: WRITES:users"]);
    });
  });

  it("does not take a same-named annotation of another package", async () => {
    const accesses = await directAccesses({
      "src/main/java/com/acme/Select.java": `package com.acme; public @interface Select { String value(); }`,
      "src/main/java/com/acme/Mapper.java": `package com.acme;
public interface Mapper { @Select("SELECT * FROM mine") Object x(); }
`,
    });
    assert.deepEqual(accesses, []);
  });
});
