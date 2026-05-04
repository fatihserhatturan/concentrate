import { GraphBuilder } from "../../../../core/graph/builder.js";
import type { GraphNode, GraphRelationshipType, ImportBinding } from "../../../../core/graph/model.js";
import {
  createResolutionRelationshipIndex,
  indexImportNodesByFile,
  indexNodesByFileAndName,
} from "../../../../core/scan/resolution/indexes.js";

type ModuleMetadataKey = "imports" | "providers" | "controllers" | "exports";

const relationshipByMetadataKey: Record<ModuleMetadataKey, GraphRelationshipType> = {
  imports: "MODULE_IMPORTS",
  providers: "MODULE_PROVIDES",
  controllers: "MODULE_CONTROLS",
  exports: "MODULE_EXPORTS",
};

export function addNestJsModuleRelationships(graph: GraphBuilder): void {
  const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
  const classesByFileAndName = indexNodesByFileAndName(graph.nodes, relationshipIndex.fileByClassId, "Class");
  const importsByFile = indexImportNodesByFile(graph.nodes, relationshipIndex.fileByImportId);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  for (const rel of graph.relationships) {
    if (rel.type !== "HAS_DECORATOR") continue;

    const moduleClass = nodeById.get(rel.from);
    const decorator = nodeById.get(rel.to);
    if (moduleClass?.label !== "Class" || decorator?.label !== "Decorator") continue;
    if (decorator.properties.name !== "Module") continue;

    const fileId = relationshipIndex.fileByClassId.get(moduleClass.id);
    if (!fileId) continue;

    const metadata = parseModuleDecoratorMetadata(decorator.properties.expression);
    for (const [key, names] of metadata) {
      for (const name of names) {
        const targetClassId = resolveClassName(
          name,
          fileId,
          classesByFileAndName,
          importsByFile,
          relationshipIndex.resolvedFileByImportId,
        );
        if (!targetClassId || targetClassId === moduleClass.id) continue;

        graph.addRelationship({
          from: moduleClass.id,
          to: targetClassId,
          type: relationshipByMetadataKey[key],
          properties: {},
        });
      }
    }
  }
}

function parseModuleDecoratorMetadata(value: unknown): Map<ModuleMetadataKey, string[]> {
  const metadata = new Map<ModuleMetadataKey, string[]>();
  if (typeof value !== "string") return metadata;

  for (const key of Object.keys(relationshipByMetadataKey) as ModuleMetadataKey[]) {
    const match = value.match(new RegExp(`\\b${key}\\s*:\\s*\\[([\\s\\S]*?)\\]`));
    if (!match?.[1]) continue;

    const names = Array.from(match[1].matchAll(/\b[A-Za-z_$][\w$]*\b/g))
      .map((item) => item[0])
      .filter((name) => !isIgnoredMetadataIdentifier(name));
    metadata.set(key, Array.from(new Set(names)));
  }

  return metadata;
}

function resolveClassName(
  name: string,
  fileId: string,
  classesByFileAndName: Map<string, Map<string, string[]>>,
  importsByFile: Map<string, GraphNode[]>,
  resolvedFileByImportId: Map<string, string>,
): string | null {
  const sameFile = classesByFileAndName.get(fileId)?.get(name)?.[0];
  if (sameFile) return sameFile;

  for (const importNode of importsByFile.get(fileId) ?? []) {
    const targetFileId = resolvedFileByImportId.get(importNode.id);
    if (!targetFileId) continue;

    const importedName = resolveImportedClassName(importNode, name);
    if (!importedName) continue;

    const imported = classesByFileAndName.get(targetFileId)?.get(importedName)?.[0]
      ?? classesByFileAndName.get(targetFileId)?.get(name)?.[0];
    if (imported) return imported;
  }

  return null;
}

function resolveImportedClassName(importNode: GraphNode, localName: string): string | null {
  const bindings = parseImportBindings(importNode);
  if (!bindings) return localName;

  const binding = bindings.find((item) => item.local === localName);
  if (!binding) return null;

  return binding.kind === "named" ? binding.imported : localName;
}

function parseImportBindings(importNode: GraphNode): ImportBinding[] | null {
  const raw = importNode.properties.bindings;
  if (typeof raw !== "string") return null;

  try {
    return JSON.parse(raw) as ImportBinding[];
  } catch {
    return null;
  }
}

function isIgnoredMetadataIdentifier(name: string): boolean {
  return name === "forwardRef"
    || name === "provide"
    || name === "useClass"
    || name === "useExisting"
    || name === "useFactory"
    || name === "useValue";
}
