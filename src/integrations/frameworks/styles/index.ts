import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";

// Styles in the graph. The style reader (languages/plain/styles.ts) gives
// every style sheet its `Style` nodes and imports; this contributor links the
// uses it could not resolve alone: `var(--x)` to the custom property
// definitions of the project.

type VarUse = { name: string; line: number };

export const stylesContributor: ISemanticContributor = {
  contribute(graph) {
    const definitions = new Map<string, Array<{ id: string; file: string }>>();
    const fileOfStyle = new Map<string, string>();
    for (const relationship of graph.relationships) {
      if (relationship.type === "DECLARES_STYLE") fileOfStyle.set(relationship.to, relationship.from);
    }
    for (const node of graph.nodes) {
      if (node.label !== "Style" || node.properties.kind !== "custom-property") continue;
      const name = String(node.properties.name);
      const list = definitions.get(name) ?? [];
      list.push({ id: node.id, file: fileOfStyle.get(node.id) ?? "" });
      definitions.set(name, list);
    }

    for (const file of graph.nodes) {
      if (file.label !== "File" || typeof file.properties.styleVarUses !== "string") continue;
      const uses = JSON.parse(file.properties.styleVarUses) as VarUse[];
      delete file.properties.styleVarUses;
      const linked = new Set<string>();
      for (const use of uses) {
        const candidates = definitions.get(use.name) ?? [];
        // A definition in the same file wins; otherwise every definition of
        // that name in the project (the cascade decides which applies).
        const local = candidates.filter((candidate) => candidate.file === file.id);
        const chosen = local.length > 0 ? local : candidates;
        for (const target of chosen) {
          const key = `${target.id}:${use.line}`;
          if (linked.has(key)) continue;
          linked.add(key);
          graph.addRelationship({
            from: file.id,
            to: target.id,
            type: "USES_STYLE",
            properties: { line: use.line, match: local.length > 0 ? "file" : "name", expression: `var(${use.name})` },
          });
        }
      }
    }
  },
};
