import type { IGraphContributor } from "../../../../core/contracts/graph-contributor.js";
import type { GraphNode, GraphRelationshipType, ImportBinding } from "../../../../core/graph/model.js";
import {
  createResolutionRelationshipIndex,
  indexImportNodesByFile,
  indexNodesByFileAndName,
} from "../../../../core/scan/resolution/indexes.js";

type ModuleMetadataKey = "imports" | "providers" | "controllers" | "exports" | "declarations";

const relationshipByMetadataKey: Record<ModuleMetadataKey, GraphRelationshipType> = {
  imports: "MODULE_IMPORTS",
  providers: "MODULE_PROVIDES",
  controllers: "MODULE_CONTROLS",
  exports: "MODULE_EXPORTS",
  declarations: "MODULE_DECLARES",
};

// The metadata keys each decorator's module graph reads: NestJS `@Module`,
// Angular `@NgModule`, and an Angular standalone `@Component`, which imports
// and provides like a module of its own.
const keysByDecorator: Record<string, ReadonlySet<ModuleMetadataKey>> = {
  Module: new Set(["imports", "providers", "controllers", "exports"]),
  NgModule: new Set(["declarations", "imports", "providers", "exports"]),
  Component: new Set(["imports", "providers"]),
};

export function addNestJsModuleRelationships(graph: IGraphContributor): void {
  const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
  const classesByFileAndName = indexNodesByFileAndName(graph.nodes, relationshipIndex.fileByClassId, "Class");
  const importsByFile = indexImportNodesByFile(graph.nodes, relationshipIndex.fileByImportId);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const angularComponentClasses = new Set(graph.relationships
    .filter((rel) => rel.type === "COMPONENT_DEFINED_BY" && nodeById.get(rel.from)?.properties.framework === "angular")
    .map((rel) => rel.to));

  for (const rel of graph.relationships) {
    if (rel.type !== "HAS_DECORATOR") continue;

    const moduleClass = nodeById.get(rel.from);
    const decorator = nodeById.get(rel.to);
    if (moduleClass?.label !== "Class" || decorator?.label !== "Decorator") continue;
    const keys = keysByDecorator[String(decorator.properties.name)];
    if (!keys || (decorator.properties.name === "Component" && !angularComponentClasses.has(moduleClass.id))) continue;

    const fileId = relationshipIndex.fileByClassId.get(moduleClass.id);
    if (!fileId) continue;

    const metadata = parseModuleDecoratorMetadata(decorator.properties.expression);
    for (const [key, names] of metadata) {
      if (!keys.has(key)) continue;
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

// Reads the top-level keys of @Module({...}). Each array element names a class:
// `Foo`, `forwardRef(() => Foo)`, a dynamic module `Foo.forRoot(...)` (Foo),
// `new Foo()`, or a provider object `{ provide: X, useClass: Foo }` (its values).
// Arguments of dynamic modules, such as TypeOrmModule.forFeature([Entity]), are
// not elements of the array.
export function parseModuleDecoratorMetadata(value: unknown): Map<ModuleMetadataKey, string[]> {
  const metadata = new Map<ModuleMetadataKey, string[]>();
  if (typeof value !== "string") return metadata;

  const source = stripComments(value);
  const objectStart = source.indexOf("{");
  if (objectStart === -1) return metadata;
  const objectBody = source.slice(objectStart + 1, matchingBracket(source, objectStart));

  for (const property of splitTopLevel(objectBody)) {
    const match = property.match(/^\s*["']?([A-Za-z_$][\w$]*)["']?\s*:\s*\[/);
    const key = match?.[1];
    if (!key || !(key in relationshipByMetadataKey)) continue;

    const arrayStart = property.indexOf("[");
    const elements = splitTopLevel(property.slice(arrayStart + 1, matchingBracket(property, arrayStart)));
    const names = elements.flatMap(classNamesOfElement).filter((name) => !isIgnoredMetadataIdentifier(name));
    metadata.set(key as ModuleMetadataKey, Array.from(new Set(names)));
  }

  return metadata;
}

function classNamesOfElement(element: string): string[] {
  const text = element.trim().replace(/^\.\.\./, "");
  const identifier = text.match(/^[A-Za-z_$][\w$]*$/);
  if (identifier) return [identifier[0]];

  const forwardRef = text.match(/^forwardRef\s*\(\s*\(\s*\)\s*=>\s*([A-Za-z_$][\w$]*)\s*\)$/);
  if (forwardRef?.[1]) return [forwardRef[1]];

  const instance = text.match(/^new\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (instance?.[1]) return [instance[1]];

  const dynamicModule = text.match(/^([A-Za-z_$][\w$]*)\s*\.\s*[A-Za-z_$][\w$]*\s*\(/);
  if (dynamicModule?.[1]) return [dynamicModule[1]];

  if (text.startsWith("{")) {
    return splitTopLevel(text.slice(1, matchingBracket(text, 0))).flatMap((pair) => {
      const separator = pair.indexOf(":");
      return separator === -1 ? [] : classNamesOfElement(pair.slice(separator + 1));
    });
  }

  return [];
}

const openingBrackets = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);

// Index of the bracket closing the one at `start` (or the end of the text).
function matchingBracket(text: string, start: number): number {
  const stack: string[] = [];
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "'" || char === "\"" || char === "`") {
      index = skipString(text, index);
    } else if (openingBrackets.has(char)) {
      stack.push(openingBrackets.get(char)!);
    } else if (char === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return text.length;
}

// Splits on commas that are not nested in brackets or strings.
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "'" || char === "\"" || char === "`") {
      index = skipString(text, index);
    } else if (openingBrackets.has(char)) {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.filter((part) => part.trim() !== "");
}

function skipString(text: string, start: number): number {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === quote) return index;
  }
  return text.length;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
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
