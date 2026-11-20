import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { ResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { createJavaTypeIndex, parseStringList, type JavaType } from "./types.js";

// Java type hierarchy, looked up through `types.ts` (enclosing types, imports,
// the package, on-demand imports, fully qualified names):
//   class A extends B           A EXTENDS B
//   class A implements I, J     A IMPLEMENTS I, A IMPLEMENTS J
//   new I() { ... }             the anonymous class IMPLEMENTS I (EXTENDS when I is a class)
//   A(1) { ... } in an enum     the constant's body class EXTENDS the enum
// Generic arguments stay on the nodes (`typeParameters`, `bases`); a base that
// is not part of the scan (JDK, third party) adds nothing.
export function addJavaInheritanceRelationships(graph: IGraphContributor, index: ResolutionRelationshipIndex): void {
  const types = createJavaTypeIndex(graph, index);
  const declared = new Set<string>();
  const add = (from: JavaType, to: JavaType, type: "EXTENDS" | "IMPLEMENTS") => {
    if (from.id === to.id) return;
    const key = `${from.id}\0${to.id}\0${type}`;
    if (declared.has(key)) return;
    declared.add(key);
    graph.addRelationship({ from: from.id, to: to.id, type, properties: {} });
  };

  for (const type of types.types) {
    const scope = { fileId: type.fileId, typeId: type.node.properties.nesting === "anonymous" ? type.id : types.enclosing(type)?.id ?? null };
    const lookup = (name: string) => types.resolve(name, scope) ?? types.resolve(name, { fileId: type.fileId, typeId: type.id });
    // `interface I extends J` has no edge: EXTENDS is Class to Class in the graph schema and the store
    // rejects anything else. The call resolver reads `embeds` itself (types.ts) to see inherited methods.
    if (type.isInterface) continue;
    for (const name of parseStringList(type.node.properties.extendsNames)) {
      const target = lookup(name);
      if (!target) continue;
      add(type, target, target.isInterface ? "IMPLEMENTS" : "EXTENDS");
    }
    for (const name of parseStringList(type.node.properties.implementsNames)) {
      const target = lookup(name);
      if (target?.isInterface) add(type, target, "IMPLEMENTS");
    }
  }
}
