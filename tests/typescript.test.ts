import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { typescriptParser } from "../src/parsers/javascript-like.js";

const fixtureRoot = path.resolve("fixtures/parser-typescript");
const fixturePath = path.join(fixtureRoot, "index.ts");
const classExpressionRoot = path.resolve("fixtures/class-expression");
const classExpressionPath = path.join(classExpressionRoot, "typescript.ts");
const constructorParameterRoot = path.resolve("fixtures/constructor-parameter-properties");
const constructorParameterPath = path.join(constructorParameterRoot, "service.ts");
const localReExportRoot = path.resolve("fixtures/local-re-exports");
const localReExportPath = path.join(localReExportRoot, "index.ts");

describe("TypeScript parser", () => {
  it("extracts file node with correct language", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const file = result.nodes.find((n) => n.label === "File");
    assert.ok(file);
    assert.equal(file.properties.language, "typescript");
  });

  it("extracts exported function declaration", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "greet");
    assert.ok(fn);
    assert.equal(fn.properties.isExported, true);
    assert.equal(fn.properties.isAsync, false);
    assert.equal(fn.properties.kind, "function_declaration");
    assert.equal(fn.properties.visibility, "public");
  });

  it("extracts exported arrow function", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "add");
    assert.ok(fn);
    assert.equal(fn.properties.kind, "arrow_function");
    assert.equal(fn.properties.isExported, true);
    assert.equal(fn.properties.isAsync, false);
  });

  it("extracts exported async arrow function", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "fetchData");
    assert.ok(fn);
    assert.equal(fn.properties.kind, "arrow_function");
    assert.equal(fn.properties.isAsync, true);
    assert.equal(fn.properties.isExported, true);
  });

  it("extracts non-exported arrow function", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const fn = result.nodes.find((n) => n.label === "Function" && n.properties.name === "_internal");
    assert.ok(fn);
    assert.equal(fn.properties.isExported, false);
  });

  it("extracts exported class", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const cls = result.nodes.find((n) => n.label === "Class" && n.properties.name === "UserService");
    assert.ok(cls);
    assert.equal(cls.properties.isExported, true);
    assert.equal(cls.properties.isAbstract, false);
  });

  it("extracts TypeScript interface, type alias, and enum declarations", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const iface = result.nodes.find((n) => n.label === "Interface" && n.properties.name === "UserRecord");
    const typeAlias = result.nodes.find((n) => n.label === "TypeAlias" && n.properties.name === "UserId");
    const enumNode = result.nodes.find((n) => n.label === "Enum" && n.properties.name === "UserRole");

    assert.ok(iface);
    assert.ok(typeAlias);
    assert.ok(enumNode);
    assert.equal(iface.properties.isExported, true);
    assert.equal(typeAlias.properties.isExported, false);
    assert.equal(enumNode.properties.isExported, true);
  });

  it("relates TypeScript declarations to their file", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const iface = result.nodes.find((n) => n.label === "Interface" && n.properties.name === "UserRecord")!;
    const typeAlias = result.nodes.find((n) => n.label === "TypeAlias" && n.properties.name === "UserId")!;
    const enumNode = result.nodes.find((n) => n.label === "Enum" && n.properties.name === "UserRole")!;

    assert.ok(result.relationships.some((r) => (
      r.from === result.fileNodeId && r.to === iface.id && r.type === "DEFINES_INTERFACE"
    )));
    assert.ok(result.relationships.some((r) => (
      r.from === result.fileNodeId && r.to === typeAlias.id && r.type === "DEFINES_TYPE_ALIAS"
    )));
    assert.ok(result.relationships.some((r) => (
      r.from === result.fileNodeId && r.to === enumNode.id && r.type === "DEFINES_ENUM"
    )));
  });

  it("attributes methods to class via DEFINES_METHOD", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const cls = result.nodes.find((n) => n.label === "Class" && n.properties.name === "UserService")!;
    const getMethod = result.nodes.find((n) => n.label === "Function" && n.properties.name === "getName");
    const fetchMethod = result.nodes.find((n) => n.label === "Function" && n.properties.name === "fetchUser");
    assert.ok(getMethod);
    assert.ok(fetchMethod);
    assert.equal(getMethod.properties.className, "UserService");
    assert.equal(fetchMethod.properties.className, "UserService");
    assert.equal(getMethod.properties.methodKind, "method");
    assert.equal(getMethod.properties.visibility, "public");
    assert.equal(getMethod.properties.isAsync, false);
    assert.equal(fetchMethod.properties.isAsync, true);
    assert.ok(result.relationships.some((r) => r.from === cls.id && r.to === getMethod.id && r.type === "DEFINES_METHOD"));
    assert.ok(result.relationships.some((r) => r.from === cls.id && r.to === fetchMethod.id && r.type === "DEFINES_METHOD"));
  });

  it("does not emit DEFINES_FUNCTION for class methods", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const getMethod = result.nodes.find((n) => n.label === "Function" && n.properties.name === "getName")!;
    assert.ok(!result.relationships.some((r) => r.to === getMethod.id && r.type === "DEFINES_FUNCTION"));
  });

  it("extracts parameters and returnType for function declarations and arrow functions", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);

    const greet = result.nodes.find((n) => n.label === "Function" && n.properties.name === "greet")!;
    assert.deepEqual(JSON.parse(greet.properties.parameters as string), [
      { name: "name", type: "string" },
    ]);
    assert.equal(greet.properties.returnType, "string");

    const add = result.nodes.find((n) => n.label === "Function" && n.properties.name === "add")!;
    assert.deepEqual(JSON.parse(add.properties.parameters as string), [
      { name: "a", type: "number" },
      { name: "b", type: "number" },
    ]);
    assert.equal(add.properties.returnType, "number");

    const fetchData = result.nodes.find((n) => n.label === "Function" && n.properties.name === "fetchData")!;
    assert.deepEqual(JSON.parse(fetchData.properties.parameters as string), [
      { name: "url", type: "string" },
    ]);
    assert.equal(fetchData.properties.returnType, "Promise<string>");

    const internal = result.nodes.find((n) => n.label === "Function" && n.properties.name === "_internal")!;
    assert.deepEqual(JSON.parse(internal.properties.parameters as string), []);
    assert.equal(internal.properties.returnType, "void");
  });

  it("extracts parameters and returnType for class methods", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);

    const getName = result.nodes.find((n) => n.label === "Function" && n.properties.name === "getName")!;
    assert.deepEqual(JSON.parse(getName.properties.parameters as string), [
      { name: "id", type: "string" },
    ]);
    assert.equal(getName.properties.returnType, "string");

    const fetchUser = result.nodes.find((n) => n.label === "Function" && n.properties.name === "fetchUser")!;
    assert.deepEqual(JSON.parse(fetchUser.properties.parameters as string), [
      { name: "id", type: "string" },
    ]);
    assert.equal(fetchUser.properties.returnType, "Promise<string>");
  });

  it("tracks getter and setter method kinds", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);

    const displayNameMethods = result.nodes.filter((n) => n.label === "Function" && n.properties.name === "displayName");
    assert.equal(displayNameMethods.length, 2);
    assert.ok(displayNameMethods.some((method) => method.properties.methodKind === "get"));
    assert.ok(displayNameMethods.some((method) => method.properties.methodKind === "set"));
  });

  it("tracks abstract classes and methods", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);

    const baseRepository = result.nodes.find((n) => n.label === "Class" && n.properties.name === "BaseRepository")!;
    assert.ok(baseRepository);
    assert.equal(baseRepository.properties.isExported, true);
    assert.equal(baseRepository.properties.isAbstract, true);

    const findById = result.nodes.find((n) => n.label === "Function" && n.properties.name === "findById")!;
    const save = result.nodes.find((n) => n.label === "Function" && n.properties.name === "save")!;
    const kind = result.nodes.find((n) => n.label === "Function" && n.properties.name === "kind")!;
    assert.ok(findById);
    assert.ok(save);
    assert.ok(kind);
    assert.equal(findById.properties.isAbstract, true);
    assert.equal(findById.properties.methodKind, "method");
    assert.deepEqual(JSON.parse(findById.properties.parameters as string), [
      { name: "id", type: "string" },
    ]);
    assert.equal(findById.properties.returnType, "string");
    assert.equal(save.properties.isAbstract, true);
    assert.equal(save.properties.visibility, "protected");
    assert.equal(kind.properties.isAbstract, false);
    assert.equal(kind.properties.methodKind, "get");
    assert.ok(result.relationships.some((r) => r.from === baseRepository.id && r.to === findById.id && r.type === "DEFINES_METHOD"));
    assert.ok(result.relationships.some((r) => r.from === baseRepository.id && r.to === save.id && r.type === "DEFINES_METHOD"));
    assert.ok(!result.relationships.some((r) => r.to === findById.id && r.type === "DEFINES_FUNCTION"));
  });

  it("extracts class fields with correct modifiers", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);
    const cls = result.nodes.find((n) => n.label === "Class" && n.properties.name === "UserService")!;

    const fields = result.nodes.filter((n) => n.label === "Field");
    assert.equal(fields.length, 7, "Expected 7 Field nodes");

    const userId = fields.find((f) => f.properties.name === "userId")!;
    assert.equal(userId.properties.typeName, "string");
    assert.equal(userId.properties.visibility, "public");
    assert.equal(userId.properties.isStatic, false);
    assert.equal(userId.properties.isReadonly, false);

    const password = fields.find((f) => f.properties.name === "password")!;
    assert.equal(password.properties.typeName, "string");
    assert.equal(password.properties.visibility, "private");
    assert.equal(password.properties.isStatic, false);

    const role = fields.find((f) => f.properties.name === "role")!;
    assert.equal(role.properties.visibility, "protected");

    const apiKey = fields.find((f) => f.properties.name === "apiKey")!;
    assert.equal(apiKey.properties.isReadonly, true);
    assert.equal(apiKey.properties.visibility, "public");

    const instanceCount = fields.find((f) => f.properties.name === "instanceCount")!;
    assert.equal(instanceCount.properties.typeName, "number");
    assert.equal(instanceCount.properties.isStatic, true);
    assert.equal(instanceCount.properties.visibility, "public");

    const secret = fields.find((f) => f.properties.name === "#secret")!;
    assert.equal(secret.properties.visibility, "private");
    assert.equal(secret.properties.typeName, "string");

    const name = fields.find((f) => f.properties.name === "name")!;
    assert.equal(name.properties.visibility, "public");
    assert.equal(name.properties.typeName, "string");

    // all fields must be linked from the class via DEFINES_FIELD
    for (const field of fields) {
      assert.ok(
        result.relationships.some((r) => r.from === cls.id && r.to === field.id && r.type === "DEFINES_FIELD"),
        `DEFINES_FIELD missing for ${field.properties.name}`,
      );
    }
  });

  it("extracts class decorator and links it via HAS_DECORATOR", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);

    const apiController = result.nodes.find((n) => n.label === "Class" && n.properties.name === "ApiController")!;
    assert.ok(apiController, "ApiController class");

    const classDecorators = result.nodes.filter(
      (n) => n.label === "Decorator"
        && result.relationships.some((r) => r.from === apiController.id && r.to === n.id && r.type === "HAS_DECORATOR"),
    );
    assert.equal(classDecorators.length, 1, "Expected 1 class decorator on ApiController");

    const injectable = classDecorators[0]!;
    assert.equal(injectable.properties.name, "Injectable");
    assert.ok((injectable.properties.expression as string).startsWith("@Injectable"));
  });

  it("extracts method decorators and links them via HAS_METHOD_DECORATOR", async () => {
    const result = await typescriptParser.parse(fixtureRoot, fixturePath);

    const findAll = result.nodes.find((n) => n.label === "Function" && n.properties.name === "findAll")!;
    const create  = result.nodes.find((n) => n.label === "Function" && n.properties.name === "create")!;
    assert.ok(findAll, "findAll method");
    assert.ok(create,  "create method");

    const findAllDecorators = result.nodes.filter(
      (n) => n.label === "Decorator"
        && result.relationships.some((r) => r.from === findAll.id && r.to === n.id && r.type === "HAS_METHOD_DECORATOR"),
    );
    assert.equal(findAllDecorators.length, 1, "Expected 1 decorator on findAll");
    assert.equal(findAllDecorators[0]!.properties.name, "Get");

    const createDecorators = result.nodes.filter(
      (n) => n.label === "Decorator"
        && result.relationships.some((r) => r.from === create.id && r.to === n.id && r.type === "HAS_METHOD_DECORATOR"),
    );
    assert.equal(createDecorators.length, 1, "Expected 1 decorator on create");
    assert.equal(createDecorators[0]!.properties.name, "Post");
  });

  it("extracts TypeScript class expressions assigned to variables as classes", async () => {
    const result = await typescriptParser.parse(classExpressionRoot, classExpressionPath);

    const repository = result.nodes.find((n) => n.label === "Class" && n.properties.name === "Repository")!;
    assert.ok(repository, "Repository class expression");
    assert.equal(repository.properties.isExported, true);
    assert.deepEqual(JSON.parse(repository.properties.extendsNames as string), ["BaseService"]);
    assert.ok(result.relationships.some((r) => r.from === result.fileNodeId && r.to === repository.id && r.type === "DEFINES_CLASS"));
    assert.equal(result.nodes.find((n) => n.label === "Variable" && n.properties.name === "Repository"), undefined);
  });

  it("extracts TypeScript class expression fields, methods, and decorators", async () => {
    const result = await typescriptParser.parse(classExpressionRoot, classExpressionPath);
    const repository = result.nodes.find((n) => n.label === "Class" && n.properties.name === "Repository")!;

    const tableName = result.nodes.find((n) => n.label === "Field" && n.properties.name === "tableName")!;
    assert.ok(tableName, "tableName field");
    assert.equal(tableName.properties.typeName, "string");
    assert.equal(tableName.properties.isReadonly, true);
    assert.ok(result.relationships.some((r) => r.from === repository.id && r.to === tableName.id && r.type === "DEFINES_FIELD"));

    const save = result.nodes.find((n) => n.label === "Function" && n.properties.name === "save")!;
    assert.ok(save, "save method");
    assert.equal(save.properties.className, "Repository");
    assert.equal(save.properties.isAsync, true);
    assert.deepEqual(JSON.parse(save.properties.parameters as string), [
      { name: "id", type: "string" },
    ]);
    assert.equal(save.properties.returnType, "Promise<string>");
    assert.ok(result.relationships.some((r) => r.from === repository.id && r.to === save.id && r.type === "DEFINES_METHOD"));

    const classDecorators = result.nodes.filter(
      (n) => n.label === "Decorator"
        && result.relationships.some((r) => r.from === repository.id && r.to === n.id && r.type === "HAS_DECORATOR"),
    );
    assert.equal(classDecorators.length, 1);
    assert.equal(classDecorators[0]!.properties.name, "Entity");

    const methodDecorators = result.nodes.filter(
      (n) => n.label === "Decorator"
        && result.relationships.some((r) => r.from === save.id && r.to === n.id && r.type === "HAS_METHOD_DECORATOR"),
    );
    assert.equal(methodDecorators.length, 1);
    assert.equal(methodDecorators[0]!.properties.name, "Route");
  });

  it("extracts constructor parameter properties as fields", async () => {
    const result = await typescriptParser.parse(constructorParameterRoot, constructorParameterPath);
    const accountService = result.nodes.find((n) => n.label === "Class" && n.properties.name === "AccountService")!;
    assert.ok(accountService, "AccountService class");

    const fields = result.nodes.filter((n) => n.label === "Field");
    assert.equal(fields.length, 4, "Expected 4 constructor parameter Field nodes");

    const repository = fields.find((f) => f.properties.name === "repository")!;
    assert.ok(repository, "repository field");
    assert.equal(repository.properties.typeName, "Repository");
    assert.equal(repository.properties.visibility, "private");
    assert.equal(repository.properties.isReadonly, true);
    assert.equal(repository.properties.isStatic, false);

    const logger = fields.find((f) => f.properties.name === "logger")!;
    assert.ok(logger, "logger field");
    assert.equal(logger.properties.typeName, "Logger");
    assert.equal(logger.properties.visibility, "protected");
    assert.equal(logger.properties.isReadonly, false);

    const displayName = fields.find((f) => f.properties.name === "displayName")!;
    assert.ok(displayName, "displayName field");
    assert.equal(displayName.properties.typeName, "string");
    assert.equal(displayName.properties.visibility, "public");

    const serviceId = fields.find((f) => f.properties.name === "serviceId")!;
    assert.ok(serviceId, "serviceId field");
    assert.equal(serviceId.properties.typeName, "string");
    assert.equal(serviceId.properties.visibility, "public");
    assert.equal(serviceId.properties.isReadonly, true);

    assert.equal(fields.find((f) => f.properties.name === "retries"), undefined);
    for (const field of fields) {
      assert.ok(
        result.relationships.some((r) => r.from === accountService.id && r.to === field.id && r.type === "DEFINES_FIELD"),
        `DEFINES_FIELD missing for ${field.properties.name}`,
      );
    }
  });

  it("tracks local named re-exports to same-file definitions", async () => {
    const result = await typescriptParser.parse(localReExportRoot, localReExportPath);

    const createClient = result.nodes.find((n) => n.label === "Function" && n.properties.name === "createClient")!;
    const localClient = result.nodes.find((n) => n.label === "Class" && n.properties.name === "LocalClient")!;
    const defaultTimeout = result.nodes.find((n) => n.label === "Variable" && n.properties.name === "defaultTimeout")!;
    const ignoredSetting = result.nodes.find((n) => n.label === "Variable" && n.properties.name === "ignoredSetting")!;

    assert.ok(createClient);
    assert.ok(localClient);
    assert.ok(defaultTimeout);
    assert.ok(ignoredSetting);
    assert.ok(result.relationships.some((r) => r.from === result.fileNodeId && r.to === createClient.id && r.type === "RE_EXPORTS"));
    assert.ok(result.relationships.some((r) => r.from === result.fileNodeId && r.to === localClient.id && r.type === "RE_EXPORTS"));
    assert.ok(result.relationships.some((r) => r.from === result.fileNodeId && r.to === defaultTimeout.id && r.type === "RE_EXPORTS"));
    assert.ok(!result.relationships.some((r) => r.from === result.fileNodeId && r.to === ignoredSetting.id && r.type === "RE_EXPORTS"));
    assert.equal(result.nodes.find((n) => n.label === "Import"), undefined);
  });
});
