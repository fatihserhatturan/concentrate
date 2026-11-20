import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { interpretMaven } from "../src/integrations/languages/java/build/maven.js";
import { readXml } from "../src/integrations/languages/java/build/xml.js";

const run = (texts: Record<string, string>) => {
  const map = new Map(Object.entries(texts));
  return interpretMaven({ files: new Set(map.keys()), texts: map });
};
const mod = (model: ReturnType<typeof run>, name: string) => {
  const found = model.modules.find((m) => m.name === name);
  assert.ok(found, `module ${name}`);
  return found;
};

const ROOT = `<?xml version="1.0"?>
<!-- root -->
<project>
  <groupId>com.acme</groupId>
  <artifactId>parent</artifactId>
  <version>1.2.0</version>
  <packaging>pom</packaging>
  <properties>
    <java.version>21</java.version>
    <lib.name>core</lib.name>
  </properties>
  <modules>
    <module>core</module>
    <module>app</module>
    <module>missing</module>
  </modules>
</project>`;

describe("xml reader", () => {
  it("reads elements, text, cdata, entities and lines", () => {
    const { root, wellFormed } = readXml(`<?xml version="1.0"?>\n<!-- c -->\n<a x="1">\n  <b>1 &lt; 2 &amp; <![CDATA[<raw>]]></b>\n  <c/>\n</a>`);
    assert.equal(wellFormed, true);
    assert.equal(root.name, "a");
    assert.equal(root.attributes.x, "1");
    assert.equal(root.children[0]!.text, "1 < 2 & <raw>");
    assert.equal(root.children[0]!.line, 4);
    assert.equal(root.children[1]!.line, 5);
  });

  it("does not throw on malformed input", () => {
    for (const bad of ["<a><b>text", "<a></b></a>", "<a", "<!-- open", "<a>< </a>", "", "<![CDATA[x"]) {
      assert.doesNotThrow(() => readXml(bad));
    }
    const partial = readXml("<a><b>text");
    assert.equal(partial.wellFormed, false);
    assert.equal(partial.root.children[0]!.text, "text");
  });
});

describe("maven pom interpretation", () => {
  const poms = {
    "pom.xml": ROOT,
    "core/pom.xml": `<project><parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.2.0</version></parent>
      <artifactId>core</artifactId></project>`,
    "app/pom.xml": `<project>
      <parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1.2.0</version></parent>
      <artifactId>app</artifactId>
      <dependencies>
        <dependency><groupId>\${project.groupId}</groupId><artifactId>\${lib.name}</artifactId><version>\${project.version}</version></dependency>
        <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>\${slf4j.version}</version></dependency>
        <dependency><groupId>com.acme</groupId><artifactId>core</artifactId><scope>test</scope></dependency>
      </dependencies>
      <dependencyManagement><dependencies>
        <dependency><groupId>com.acme</groupId><artifactId>parent</artifactId></dependency>
      </dependencies></dependencyManagement>
    </project>`,
  };

  it("inherits groupId, version, properties and parent; resolves modules", () => {
    const model = run(poms);
    assert.deepEqual(model.files, ["app/pom.xml", "core/pom.xml", "pom.xml"]);
    const core = mod(model, "com.acme:core");
    assert.equal(core.version, "1.2.0");
    assert.equal(core.parent, "maven:com.acme:parent");
    assert.equal(core.dir, "core");
    assert.deepEqual(core.sourceRoots, ["core/src/main/java"]);
    assert.deepEqual(core.testSourceRoots, ["core/src/test/java"]);
    assert.deepEqual(core.config, [
      { key: "java.version", value: "21" },
      { key: "packaging", value: "jar" },
    ]);
    const root = mod(model, "com.acme:parent");
    assert.equal(root.aggregator, true);
    assert.deepEqual(root.sourceRoots, ["src/main/java"]);
    // `missing` is not a scanned pom.
    assert.equal(root.unresolved, 1);
  });

  it("links dependencies on scanned modules and ignores external ones", () => {
    const model = run(poms);
    const app = mod(model, "com.acme:app");
    assert.deepEqual(app.dependencies, [
      { module: "maven:com.acme:core", scope: "compile" },
      { module: "maven:com.acme:core", scope: "test" },
    ]);
    // `${slf4j.version}` stands in an external version only: not counted.
    assert.equal(app.unresolved, 0);
    assert.equal(model.unresolved, 1);
  });

  it("counts unknown property references and leaves them unexpanded", () => {
    const model = run({
      "pom.xml": `<project><groupId>g</groupId><artifactId>a</artifactId><version>\${rev}</version>
        <build><sourceDirectory>\${gen}/java</sourceDirectory></build></project>`,
    });
    const a = mod(model, "g:a");
    assert.equal(a.version, "${rev}");
    assert.equal(a.unresolved, 2);
  });

  it("expands project.*, pom.* aliases and parent version", () => {
    const model = run({
      "pom.xml": `<project><parent><groupId>g</groupId><artifactId>p</artifactId><version>3</version><relativePath/></parent>
        <artifactId>a</artifactId>
        <properties><v>\${pom.version}-\${project.parent.version}-\${project.artifactId}</v><java.version>\${v}</java.version></properties></project>`,
    });
    const a = mod(model, "g:a");
    assert.equal(a.version, "3");
    assert.deepEqual(a.config[0], { key: "java.version", value: "3-3-a" });
    assert.equal(a.parent, null);
    assert.equal(a.unresolved, 0);
  });

  it("guards against recursive properties", () => {
    const model = run({
      "pom.xml": `<project><groupId>g</groupId><artifactId>a</artifactId><version>1</version>
        <properties><x>\${y}</x><y>\${x}</y><self>\${self}</self><java.version>\${x}</java.version><maven.compiler.release>\${self}</maven.compiler.release></properties></project>`,
    });
    const a = mod(model, "g:a");
    assert.equal(a.unresolved, 2);
    assert.equal(a.config.length, 3);
  });

  it("resolves modules by directory or pom file path and parents via relativePath", () => {
    const model = run({
      "pom.xml": `<project><groupId>g</groupId><artifactId>r</artifactId><version>1</version><packaging>pom</packaging>
        <modules><module>one</module><module>two/custom-pom.xml</module><module>../out</module></modules></project>`,
      "one/pom.xml": `<project><parent><groupId>g</groupId><artifactId>r</artifactId><version>1</version></parent><artifactId>one</artifactId></project>`,
      "two/custom-pom.xml": `<project><groupId>g</groupId><artifactId>two</artifactId><version>1</version></project>`,
      "x/y/pom.xml": `<project><parent><groupId>g</groupId><artifactId>r</artifactId><version>1</version><relativePath>../../pom.xml</relativePath></parent><artifactId>y</artifactId></project>`,
    });
    // Only `../out` is missing.
    assert.equal(mod(model, "g:r").unresolved, 1);
    assert.equal(mod(model, "g:y").parent, "maven:g:r");
    assert.equal(mod(model, "g:one").parent, "maven:g:r");
    assert.equal(mod(model, "g:two").dir, "two");
  });

  it("honours custom source directories relative to the scan root", () => {
    const model = run({
      "svc/pom.xml": `<project><groupId>g</groupId><artifactId>svc</artifactId><version>1</version>
        <properties><src>src</src></properties>
        <build><sourceDirectory>\${project.basedir}/\${src}/main</sourceDirectory><testSourceDirectory>tests/java</testSourceDirectory></build></project>`,
    });
    const svc = mod(model, "g:svc");
    assert.deepEqual(svc.sourceRoots, ["svc/src/main"]);
    assert.deepEqual(svc.testSourceRoots, ["svc/tests/java"]);
    assert.equal(svc.unresolved, 0);
  });

  it("reads the main class of the three plugins", () => {
    const plugin = (artifactId: string, configuration: string) =>
      `<project><groupId>g</groupId><artifactId>m</artifactId><version>1</version><properties><mc>com.Main</mc></properties>
        <build><plugins><plugin><artifactId>${artifactId}</artifactId><configuration>${configuration}</configuration></plugin></plugins></build></project>`;
    const cases: Array<[string, string, string]> = [
      ["spring-boot-maven-plugin", "<mainClass>com.Boot</mainClass>", "com.Boot"],
      ["exec-maven-plugin", "<mainClass>${mc}</mainClass>", "com.Main"],
      ["maven-jar-plugin", "<archive><manifest><mainClass>com.Jar</mainClass></manifest></archive>", "com.Jar"],
    ];
    for (const [artifactId, configuration, expected] of cases) {
      const m = mod(run({ "pom.xml": plugin(artifactId, configuration) }), "g:m");
      assert.equal(m.mainClass, expected);
      assert.equal(m.mainClassSource, artifactId);
    }
    const managed = mod(
      run({
        "pom.xml": `<project><groupId>g</groupId><artifactId>m</artifactId><build><pluginManagement><plugins>
          <plugin><artifactId>exec-maven-plugin</artifactId><executions><execution><configuration><mainClass>com.Exec</mainClass></configuration></execution></executions></plugin>
          </plugins></pluginManagement></build></project>`,
      }),
      "g:m",
    );
    assert.equal(managed.mainClass, "com.Exec");
    const startClass = mod(
      run({ "pom.xml": `<project><groupId>g</groupId><artifactId>m</artifactId><properties><start-class>com.Start</start-class></properties></project>` }),
      "g:m",
    );
    assert.equal(startClass.mainClass, "com.Start");
    assert.equal(startClass.mainClassSource, "spring-boot-maven-plugin");
  });

  it("returns what it could read from a malformed pom", () => {
    const model = run({
      "pom.xml": `<project><groupId>g</groupId><artifactId>a</artifactId><version>1</version><dependencies><dependency><groupId>`,
      "bad/pom.xml": `<<<not xml`,
      "empty/pom.xml": ``,
    });
    assert.equal(model.modules.length, 1);
    assert.equal(mod(model, "g:a").version, "1");
    assert.deepEqual(model.files, ["pom.xml"]);
  });
});
