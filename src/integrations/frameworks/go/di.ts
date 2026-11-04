import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GoParsePlugin } from "../../languages/go/parser.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { createGoCallIndex, firstResultType, resolveType, type GoCallIndex, type TypeRef } from "../../../core/scan/resolution/go-calls.js";
import { importedPackages } from "./routes.js";

// Go dependency injection with uber fx and google wire, as INJECTS between
// structs (like NestJS constructor injection):
//   - a provider is a function passed to `fx.Provide` (also inside
//     `fx.Annotate(F, …)`, `fx.Module`, `fx.Options`), `wire.NewSet` or
//     `wire.Build`; the struct it returns first INJECTS the struct of each
//     parameter (`fieldName` the parameter's name), and the fields of an
//     `fx.In` parameter struct are parameters too;
//   - `wire.Struct(new(T), "*" | "Field"…)` makes T INJECT the types of
//     those fields;
//   - an interface is the struct bound to it (`wire.Bind(new(I), new(*T))`,
//     `fx.Annotate(NewT, fx.As(new(I)))`), else its only implementation
//     (IMPLEMENTS), else nothing; a provider that returns an interface is
//     the struct bound to it the same way.
// Only structs of the scan are linked; `*gorm.DB`, `*zap.Logger` and other
// dependency types are not. `fx.Invoke` functions and wire injectors have no
// struct of their own and are not linked; values (`fx.Supply`,
// `wire.Value`) take no dependencies.

type DiEntry =
  | { kind: "provide"; ref: string; as?: string[]; line: number }
  | { kind: "struct"; type: string; fields: string[]; line: number }
  | { kind: "bind"; iface: string; impl: string; line: number };

const FX = "go.uber.org/fx";
const WIRE = "github.com/google/wire";

export const goDiPlugin: GoParsePlugin = ({ fileNodeId, root, nodes }) => {
  const imports = importedPackages(root);
  const fx = imports.get(FX);
  const wire = imports.get(WIRE);
  if (!fx && !wire) return;
  const entries: DiEntry[] = [];
  const isCall = (node: SyntaxNode, alias: string | undefined, names: readonly string[]) => {
    const fn = node.type === "call_expression" ? node.childForFieldName("function") : null;
    return !!alias && fn?.type === "selector_expression" && fn.childForFieldName("operand")?.text === alias && names.includes(fn.childForFieldName("field")!.text);
  };
  const argsOf = (call: SyntaxNode) => call.childForFieldName("arguments")?.namedChildren ?? [];
  // `new(I)` → `I`.
  const newType = (node: SyntaxNode | undefined): string | null => {
    if (node?.type !== "call_expression" || node.childForFieldName("function")?.text !== "new") return null;
    const args = node.childForFieldName("arguments")?.namedChildren ?? [];
    return args[0]?.text ?? null;
  };
  const isFunctionRef = (node: SyntaxNode) => node.type === "identifier" || (node.type === "selector_expression" && node.childForFieldName("operand")?.type === "identifier");
  const line = (node: SyntaxNode) => node.startPosition.row + 1;

  for (const call of root.descendantsOfType("call_expression")) {
    if (isCall(call, fx, ["Provide"]) || isCall(call, wire, ["NewSet", "Build"])) {
      for (const arg of argsOf(call)) {
        if (isFunctionRef(arg)) entries.push({ kind: "provide", ref: arg.text, line: line(arg) });
        else if (isCall(arg, fx, ["Annotate"])) {
          const [target, ...annotations] = argsOf(arg);
          const as = annotations.filter((annotation) => isCall(annotation, fx, ["As"])).flatMap((annotation) => argsOf(annotation).map((value) => newType(value)).filter((type): type is string => type !== null));
          if (target && isFunctionRef(target)) entries.push({ kind: "provide", ref: target.text, ...(as.length > 0 ? { as } : {}), line: line(target) });
        }
      }
    } else if (isCall(call, wire, ["Struct"])) {
      const [target, ...fields] = argsOf(call);
      const type = newType(target);
      if (type) {
        entries.push({
          kind: "struct",
          type,
          fields: fields.filter((field) => field.type === "interpreted_string_literal" || field.type === "raw_string_literal").map((field) => field.text.slice(1, -1)),
          line: line(call),
        });
      }
    } else if (isCall(call, wire, ["Bind"])) {
      const [iface, impl] = argsOf(call).map((arg) => newType(arg));
      if (iface && impl) entries.push({ kind: "bind", iface, impl, line: line(call) });
    }
  }
  const file = nodes.find((node) => node.id === fileNodeId);
  if (file && entries.length > 0) file.properties.goDi = JSON.stringify(entries);
};

type Provider = { fn: GraphNode; fileId: string; as: string[] };

export const goDiContributor: ISemanticContributor = {
  contribute(graph) {
    const files = graph.nodes.filter((node) => node.label === "File" && typeof node.properties.goDi === "string");
    if (files.length === 0) return;
    const entriesByFile = new Map<string, DiEntry[]>();
    for (const file of files) {
      entriesByFile.set(file.id, JSON.parse(String(file.properties.goDi)) as DiEntry[]);
      delete file.properties.goDi;
    }
    const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
    const index = createGoCallIndex(graph, relationshipIndex);
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const key = (type: TypeRef) => `${type.pkg}\0${type.name}`;
    const classOf = (type: TypeRef | null) => (type ? index.typesByPackage.get(type.pkg)?.get(type.name)?.node : undefined);
    const interfaceOf = (type: TypeRef | null) => (type ? index.interfacesByPackage.get(type.pkg)?.get(type.name)?.node : undefined);

    // Interface → the struct bound to it.
    const bound = new Map<string, Set<string>>();
    const bind = (iface: TypeRef | null, impl: GraphNode | undefined) => {
      if (!iface || !impl || !interfaceOf(iface)) return;
      bound.set(key(iface), new Set([...bound.get(key(iface)) ?? [], impl.id]));
    };

    const providers: Provider[] = [];
    const structs: Array<{ type: TypeRef; fields: string[] }> = [];
    for (const [fileId, entries] of entriesByFile) {
      for (const entry of entries) {
        if (entry.kind === "bind") {
          bind(resolveType(entry.iface, fileId, index), classOf(resolveType(entry.impl, fileId, index)));
        } else if (entry.kind === "struct") {
          const type = resolveType(entry.type, fileId, index);
          if (classOf(type)) structs.push({ type: type!, fields: entry.fields });
        } else {
          const fn = functionOf(entry.ref, fileId, index);
          const fnFile = fn ? index.fileByFunctionId.get(fn.id) : undefined;
          if (fn && fnFile) providers.push({ fn, fileId: fnFile, as: (entry.as ?? []).map((as) => `${fileId}\0${as}`) });
        }
      }
    }
    for (const provider of providers) {
      const result = resultType(provider);
      for (const as of provider.as) {
        const [fileId, text] = as.split("\0") as [string, string];
        bind(resolveType(text, fileId, index), classOf(result));
      }
    }

    // A type as the struct injected: the struct itself, or the one struct
    // an interface is bound to or implemented by.
    const structOf = (type: TypeRef | null): GraphNode | undefined => {
      const own = classOf(type);
      if (own) return own;
      const iface = interfaceOf(type);
      if (!iface || !type) return undefined;
      const ids = bound.get(key(type));
      if (ids?.size === 1) return nodeById.get([...ids][0]!);
      if (ids && ids.size > 1) return undefined;
      const implementers = index.implementersByInterface.get(iface.id) ?? [];
      return implementers.length === 1 ? classOf(implementers[0]!) : undefined;
    };

    function resultType(provider: Provider): TypeRef | null {
      const result = firstResultType(provider.fn.properties.returnType);
      return result ? resolveType(result, provider.fileId, index) : null;
    }

    const added = new Set<string>();
    const relationships: GraphRelationship[] = [];
    const inject = (consumer: GraphNode | undefined, dependency: GraphNode | undefined, fieldName: string | null) => {
      if (!consumer || !dependency || consumer.id === dependency.id) return;
      const id = `${consumer.id}\0${dependency.id}\0${fieldName}`;
      if (added.has(id)) return;
      added.add(id);
      relationships.push({ from: consumer.id, to: dependency.id, type: "INJECTS", properties: { fieldName } });
    };

    for (const provider of providers) {
      const consumer = structOf(resultType(provider));
      if (!consumer) continue;
      for (const parameter of parameters(provider.fn)) {
        if (!parameter.type) continue;
        const type = resolveType(parameter.type.replace(/^\.\.\./u, ""), provider.fileId, index);
        const owner = classOf(type);
        // `fx.In` parameter structs: each field is a dependency.
        const inFields = owner ? fieldsOf(owner) : [];
        if (inFields.some((field) => field.embedded && /(?:^|\.)In$/u.test(field.type))) {
          const ownerFile = index.typesByPackage.get(type!.pkg)?.get(type!.name)?.fileId ?? provider.fileId;
          for (const field of inFields) {
            if (!field.embedded) inject(consumer, structOf(resolveType(field.type, ownerFile, index)), field.name);
          }
          continue;
        }
        inject(consumer, structOf(type), parameter.name);
      }
    }
    for (const { type, fields } of structs) {
      const owner = index.typesByPackage.get(type.pkg)?.get(type.name);
      if (!owner) continue;
      for (const field of fieldsOf(owner.node)) {
        if (field.embedded || !(fields.includes("*") || fields.includes(field.name))) continue;
        inject(owner.node, structOf(resolveType(field.type, owner.fileId, index)), field.name);
      }
    }
    for (const relationship of relationships) graph.addRelationship(relationship);
  },
};

// `NewStore` (the file's package) or `store.New` (an imported package).
function functionOf(ref: string, fileId: string, index: GoCallIndex): GraphNode | undefined {
  const [qualifier, name] = ref.includes(".") ? ref.split(".") : [null, ref];
  const packages = qualifier === null ? [index.packageByFile.get(fileId)!, ...index.importsByFile.get(fileId)?.get(".") ?? []] : index.importsByFile.get(fileId)?.get(qualifier) ?? [];
  for (const pkg of packages) {
    const fn = index.functionsByPackage.get(pkg)?.get(name!);
    if (fn) return fn;
  }
  return undefined;
}

function parameters(fn: GraphNode): Array<{ name: string | null; type: string | null }> {
  try {
    return JSON.parse(String(fn.properties.parameters ?? "[]")) as Array<{ name: string | null; type: string | null }>;
  } catch {
    return [];
  }
}

function fieldsOf(node: GraphNode): Array<{ name: string; type: string; embedded?: true }> {
  try {
    return JSON.parse(String(node.properties.fields ?? "[]")) as Array<{ name: string; type: string; embedded?: true }>;
  } catch {
    return [];
  }
}
