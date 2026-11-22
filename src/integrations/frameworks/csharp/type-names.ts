import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { normalizeCSharpType, trailingArity } from "../../languages/csharp/syntax.js";
import { createCSharpTypeIndex, type CSharpType, type CSharpTypeIndex, type CSharpTypeScope } from "../../languages/csharp/types.js";
import { basesOf, csharpFileOfId } from "./shared.js";

// Resolves a C# type name written in the code to its Class / Interface node with the Phase 44 type index
// (namespaces, usings, aliases, nesting, generic arity, project visibility), and walks base types including the
// ones outside the scan (`ControllerBase`, `Hub`, `BackgroundService`, `Greeter.GreeterBase` are not scanned types).

export type ExternalBase = {
  /** The name as written in the base list (generic arguments stripped): `ControllerBase`, `Greeter.GreeterBase`. */
  name: string;
  /** Last segment: `GreeterBase`. */
  simpleName: string;
  /** The scanned type whose base list wrote it. */
  declaredBy: CSharpType;
};

export type CSharpTypeResolver = {
  index: CSharpTypeIndex;
  /** The scope (file, enclosing type, namespace, line) a Class, Interface, Field, Function, Decorator or Call node is written in. */
  scopeOf(node: GraphNode): CSharpTypeScope | undefined;
  /** The Class or Interface that declares a member Function or Field; the node itself for a type; undefined otherwise. */
  ownerOf(node: GraphNode): GraphNode | undefined;
  /** Resolves a type as written (`IFoo`, `List<IFoo>` gives `List`, `A.B`, `IFoo?`) at the use site `scopeNode`; null for keywords, tuples, unknown or ambiguous names. */
  resolve(typeText: string, scopeNode: GraphNode): CSharpType | null;
  /** The CSharpType of a Class / Interface node. */
  typeOf(node: GraphNode): CSharpType | undefined;
  /** Base types outside the scan, transitively through the scanned ones (own base list first). */
  externalBases(type: CSharpType): ExternalBase[];
  /** True when the type or a scanned ancestor lists a base whose last segment is one of `simpleNames` (`["ControllerBase", "Controller"]`). */
  derivesFromExternal(type: CSharpType, simpleNames: readonly string[]): boolean;
  /** True when `type` is `ancestor` or has it as a scanned ancestor (class or interface). */
  isSubtypeOf(type: CSharpType, ancestor: CSharpType): boolean;
  /** Function nodes the type declares (methods, constructors, accessors), source order. */
  methodsOf(type: CSharpType): GraphNode[];
};

const PARENT_RELATIONS = ["DEFINES_METHOD", "DEFINES_INTERFACE_METHOD", "DEFINES_FIELD", "DEFINES_INTERFACE_FIELD"] as const;

export function csharpTypeResolver(graph: IGraphContributor): CSharpTypeResolver {
  const index = createCSharpTypeIndex(graph, createResolutionRelationshipIndex(graph));
  const parentOf = new Map<string, string>();
  const membersOf = new Map<string, GraphNode[]>();
  for (const type of PARENT_RELATIONS) {
    for (const rel of graph.relationshipsOfType(type as GraphRelationship["type"])) {
      parentOf.set(rel.to, rel.from);
      if (!type.endsWith("METHOD")) continue;
      const member = graph.node(rel.to);
      if (!member) continue;
      const list = membersOf.get(rel.from);
      if (list) list.push(member);
      else membersOf.set(rel.from, [member]);
    }
  }
  const ownerOf = (node: GraphNode): GraphNode | undefined => {
    if (node.label === "Class" || node.label === "Interface") return node;
    if (node.label === "Call") {
      const functionId = node.id.slice(0, node.id.indexOf(":call:"));
      const fn = graph.node(functionId);
      return fn ? ownerOf(fn) : undefined;
    }
    if (node.label === "Decorator") return undefined;
    const parent = parentOf.get(node.id);
    return parent ? graph.node(parent) : undefined;
  };
  const scopeOf = (node: GraphNode): CSharpTypeScope | undefined => {
    // A `partial` type has one id for all files (`csharp:partial:<name>`): its first declaring file stands in.
    const fileId = csharpFileOfId(node.id) ?? index.byId.get(node.id)?.fileIds[0];
    if (!fileId) return undefined;
    const owner = ownerOf(node);
    const namespace = String(owner?.properties.namespace ?? node.properties.namespace ?? "");
    const line = typeof node.properties.line === "number" ? node.properties.line : undefined;
    return { fileId, typeId: owner?.id ?? null, namespace, ...(line === undefined ? {} : { line }) };
  };
  const external = new Map<string, ExternalBase[]>();
  const externalBases = (type: CSharpType): ExternalBase[] => {
    const known = external.get(type.id);
    if (known) return known;
    external.set(type.id, []);
    const result: ExternalBase[] = [];
    const scope = scopeOf(type.node);
    for (const base of basesOf(type.node)) {
      const resolved = scope ? index.resolve(base.name, scope, trailingArity(base.text)) : null;
      if (resolved) {
        if (resolved.id !== type.id) result.push(...externalBases(resolved));
      } else {
        result.push({ name: base.name, simpleName: base.name.slice(base.name.lastIndexOf(".") + 1), declaredBy: type });
      }
    }
    external.set(type.id, result);
    return result;
  };
  const isSubtypeOf = (type: CSharpType, ancestor: CSharpType): boolean => {
    const seen = new Set<string>();
    const stack = [type];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.id === ancestor.id) return true;
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      stack.push(...index.supertypes(current));
    }
    return false;
  };
  return {
    index,
    scopeOf,
    ownerOf,
    resolve(typeText, scopeNode) {
      const name = normalizeCSharpType(typeText);
      const scope = scopeOf(scopeNode);
      if (!name || !scope) return null;
      return index.resolve(name, scope, trailingArity(typeText));
    },
    typeOf: (node) => index.byId.get(node.id),
    externalBases,
    derivesFromExternal: (type, simpleNames) => externalBases(type).some((base) => simpleNames.includes(base.simpleName)),
    isSubtypeOf,
    methodsOf: (type) => membersOf.get(type.id) ?? [],
  };
}
