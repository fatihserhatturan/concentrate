import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import {
  addJavaRoute,
  annotationEnum,
  annotationValue,
  findAnnotations,
  hasAnnotation,
  javaAnnotationReader,
  joinRoutePath,
  type AnnotationValue,
  type JavaAnnotationInfo,
  type JavaAnnotationReader,
} from "./annotations.js";
import { javaMethods, type JavaMethod } from "./shared.js";

// HTTP routes declared by annotations: Spring MVC, JAX-RS / Jakarta REST (RESTEasy, Quarkus, Jersey)
// and Micronaut. Every annotation is matched by simple name AND package through `findAnnotations`
// (annotations.ts): one whose package is provably different never counts (a Micronaut `@Controller`,
// even from `import io.micronaut.http.annotation.*`, is not Spring's), and the method annotations
// (`@GetMapping` vs `@Get`) decide what remains.
//
// Not handled (never guessed): meta-annotations (a custom annotation composed of `@RestController`),
// `@ApplicationPath` / `server.servlet.context-path` / `quarkus.rest.path` prefixes, JAX-RS
// sub-resource locators (a method with only `@Path` has no HTTP method: no Route), inheritance
// through `interface I extends J` (the graph has no edge for it), and inherited methods that the
// subclass does not redeclare.
//
// Handlers are concrete-class instance methods: static and private methods never get a Route; JAX-RS and
// Micronaut additionally need `public`. A method inherits its supertype's mapping only when the supertype
// declares the same erased signature (simple type names, generics dropped); a differing parameter type
// matches only where the supertype's one is its own type variable. A JAX-RS resource is a class with its
// own `@Path` or one implementing an interface that has it; a subclass of a `@Path` class without its own
// `@Path` is not (no duplicated routes).

const SPRING_WEB = ["org.springframework.web.bind.annotation"];
const SPRING_STEREOTYPE = ["org.springframework.stereotype", "org.springframework.web.bind.annotation"];
const JAXRS = ["javax.ws.rs", "jakarta.ws.rs"];
const MICRONAUT = ["io.micronaut.http.annotation"];

// What the other languages use for "any method".
const ANY_METHOD = "ALL";

type Part = { value: string; resolved: boolean };
type PathResult = { path: string | null; expression: string | null };

const EMPTY: Part[][] = [[{ value: "", resolved: true }]];

// Every class path with every method path: all resolved gives the joined path, otherwise the expression.
function combine(prefixes: Part[][], suffixes: Part[][]): PathResult[] {
  const results: PathResult[] = [];
  for (const prefix of prefixes) {
    for (const suffix of suffixes) {
      const parts = [...prefix, ...suffix];
      if (parts.every((part) => part.resolved)) results.push({ path: joinRoutePath(...parts.map((part) => part.value)), expression: null });
      else {
        const written = parts.filter((part) => !part.resolved || part.value !== "").map((part) => (part.resolved ? JSON.stringify(part.value) : part.value));
        results.push({ path: null, expression: written.join(" + ") });
      }
    }
  }
  return results;
}

function alternatives(values: AnnotationValue[] | null): Part[][] {
  if (!values || values.length === 0) return EMPTY;
  return values.map((value) => [value]);
}

// The path alternatives of the first of `keys` that is written; one empty path when none is.
function pathsOf(ann: JavaAnnotationInfo | undefined, keys: readonly string[]): Part[][] {
  if (!ann) return EMPTY;
  for (const key of keys) {
    const values = annotationValue(ann, key);
    if (values) return alternatives(values);
  }
  return EMPTY;
}

type Index = {
  graph: IGraphContributor;
  reader: JavaAnnotationReader;
  /** Direct supertypes (EXTENDS, IMPLEMENTS). */
  supertypes: Map<string, GraphNode[]>;
  methodsOf: Map<string, GraphNode[]>;
  ancestorCache: Map<string, GraphNode[]>;
};

function buildIndex(graph: IGraphContributor): Index {
  const supertypes = new Map<string, GraphNode[]>();
  for (const type of ["EXTENDS", "IMPLEMENTS"] as const) {
    for (const rel of graph.relationshipsOfType(type)) {
      const target = graph.node(rel.to);
      if (!target) continue;
      const list = supertypes.get(rel.from);
      if (list) list.push(target);
      else supertypes.set(rel.from, [target]);
    }
  }
  const methodsOf = new Map<string, GraphNode[]>();
  for (const type of ["DEFINES_METHOD", "DEFINES_INTERFACE_METHOD"] as const) {
    for (const rel of graph.relationshipsOfType(type as GraphRelationship["type"])) {
      const method = graph.node(rel.to);
      if (!method) continue;
      const list = methodsOf.get(rel.from);
      if (list) list.push(method);
      else methodsOf.set(rel.from, [method]);
    }
  }
  return { graph, reader: javaAnnotationReader(graph), supertypes, methodsOf, ancestorCache: new Map() };
}

// The type's supertypes breadth first, no repeats, nearest first.
function ancestors(index: Index, type: GraphNode): GraphNode[] {
  const cached = index.ancestorCache.get(type.id);
  if (cached) return cached;
  const order = computeAncestors(index, type);
  index.ancestorCache.set(type.id, order);
  return order;
}

function computeAncestors(index: Index, type: GraphNode): GraphNode[] {
  const seen = new Set<string>([type.id]);
  const order: GraphNode[] = [];
  const queue = [type];
  for (let next = queue.shift(); next; next = queue.shift()) {
    for (const parent of index.supertypes.get(next.id) ?? []) {
      if (seen.has(parent.id)) continue;
      seen.add(parent.id);
      order.push(parent);
      queue.push(parent);
    }
  }
  return order;
}

// The erased parameter types of a method (simple names, no generics, no whitespace); null when unreadable.
function typesOfParameters(method: GraphNode): string[] | null {
  try {
    const parsed: unknown = JSON.parse(String(method.properties.parameters ?? "[]"));
    if (!Array.isArray(parsed)) return null;
    return parsed.map((parameter) => erase(String((parameter as { type?: string }).type ?? "")));
  } catch {
    return null;
  }
}

// `java.util.List<String>[]` -> `List[]`: generics dropped (erasure), package qualifiers dropped.
function erase(type: string): string {
  let text = type.replace(/\s+/gu, "");
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(/<[^<>]*>/gu, "");
  }
  const dimensions = /(\[\])+$|\.\.\.$/u.exec(text)?.[0] ?? "";
  const base = text.slice(0, text.length - dimensions.length);
  return `${base.slice(base.lastIndexOf(".") + 1)}${dimensions === "..." ? "[]" : dimensions}`;
}

function typeVariablesOf(node: GraphNode): Set<string> {
  const names = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(String(node.properties.typeParameters ?? "[]"));
    if (Array.isArray(parsed)) for (const entry of parsed) names.add(String(entry).trim().split(/[\s<:]/u)[0] ?? "");
  } catch {
    // no type variables known
  }
  return names;
}

// The same method (name, erased parameter types) in a supertype; null when absent or ambiguous. A
// parameter whose supertype type is a type variable of the supertype (class or method) matches anything.
function overridden(index: Index, parent: GraphNode, method: GraphNode): GraphNode | null {
  const types = typesOfParameters(method);
  if (!types) return null;
  const variables = typeVariablesOf(parent);
  const matches = (index.methodsOf.get(parent.id) ?? []).filter((candidate) => {
    if (candidate.properties.kind !== "method" || candidate.properties.name !== method.properties.name || candidate.properties.parameterCount !== method.properties.parameterCount) return false;
    const theirs = typesOfParameters(candidate);
    if (!theirs || theirs.length !== types.length) return false;
    const own = typeVariablesOf(candidate);
    return theirs.every((type, position) => {
      const base = type.replace(/(\[\])+$/u, "");
      return type === types[position] || variables.has(base) || own.has(base);
    });
  });
  return matches.length === 1 ? matches[0]! : null;
}

type Found = { list: JavaAnnotationInfo[]; own: boolean };

// The method's own annotations when `relevant` finds any there, else those of the same method in the
// nearest supertype that has some (Spring and JAX-RS both inherit them from interfaces and superclasses).
function methodAnnotations(index: Index, owner: GraphNode, method: GraphNode, relevant: (list: JavaAnnotationInfo[]) => boolean): Found | null {
  const own = index.reader.annotationsOf(method);
  if (relevant(own)) return { list: own, own: true };
  for (const parent of ancestors(index, owner)) {
    const match = overridden(index, parent, method);
    if (!match) continue;
    const list = index.reader.annotationsOf(match);
    if (relevant(list)) return { list, own: false };
  }
  return null;
}

// The class's own annotations when `relevant` finds any, else the nearest supertype's.
function classAnnotations(index: Index, type: GraphNode, relevant: (list: JavaAnnotationInfo[]) => boolean): JavaAnnotationInfo[] | null {
  const own = index.reader.annotationsOf(type);
  if (relevant(own)) return own;
  for (const parent of ancestors(index, type)) {
    const list = index.reader.annotationsOf(parent);
    if (relevant(list)) return list;
  }
  return null;
}

function emit(graph: IGraphContributor, method: JavaMethod, framework: string, verb: string, paths: PathResult[], line: number): void {
  for (const { path, expression } of paths) {
    addJavaRoute(graph, { fileId: method.fileId, method: verb, path, pathExpression: expression, framework, line, handler: method.node });
  }
}

// A concrete class's instance method: interfaces, abstract classes and static methods are no handlers.
// `level` is the visibility the framework needs: Spring also dispatches to package-private and
// protected methods, JAX-RS and Micronaut only to public ones. Private methods never are.
function isHandlerCandidate({ owner, node }: JavaMethod, level: "spring" | "public"): boolean {
  if (owner.label !== "Class" || owner.properties.isAbstract === true || node.properties.kind !== "method" || node.properties.isStatic === true) return false;
  const visibility = node.properties.visibility;
  return level === "public" ? visibility === "public" : visibility !== "private";
}

// ---------------------------------------------------------------- Spring MVC

const SPRING_VERBS: Record<string, string> = { GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT", DeleteMapping: "DELETE", PatchMapping: "PATCH" };
const springMapping = (list: JavaAnnotationInfo[]): JavaAnnotationInfo[] =>
  list.filter((ann) => (ann.simpleName === "RequestMapping" || ann.simpleName in SPRING_VERBS) && findAnnotations([ann], ann.simpleName, SPRING_WEB).length > 0);

function springRoutes(index: Index, method: JavaMethod): void {
  if (!isHandlerCandidate(method, "spring")) return;
  const { owner, node } = method;
  const ownerAnnotations = index.reader.annotationsOf(owner);
  if (!hasAnnotation(ownerAnnotations, "RestController", SPRING_WEB) && !hasAnnotation(ownerAnnotations, "Controller", SPRING_STEREOTYPE)) return;
  const found = methodAnnotations(index, owner, node, (list) => springMapping(list).length > 0);
  if (!found) return;
  const classMapping = classAnnotations(index, owner, (list) => findAnnotations(list, "RequestMapping", SPRING_WEB).length > 0);
  const classRequest = classMapping ? findAnnotations(classMapping, "RequestMapping", SPRING_WEB)[0] : undefined;
  const prefixes = pathsOf(classRequest, ["value", "path"]);
  const classVerbs = classRequest ? annotationEnum(classRequest, "method") : null;
  for (const ann of springMapping(found.list)) {
    let verbs: string[];
    if (ann.simpleName === "RequestMapping") {
      const written = annotationEnum(ann, "method") ?? classVerbs;
      if (written === null) verbs = [ANY_METHOD];
      else if (written.length === 0) continue; // written as something other than constants: unknown, no Route
      else verbs = written.map((verb) => verb.toUpperCase());
    } else verbs = [SPRING_VERBS[ann.simpleName]!];
    const paths = combine(prefixes, pathsOf(ann, ["value", "path"]));
    const line = found.own ? ann.line : Number(node.properties.line);
    for (const verb of [...new Set(verbs)]) emit(index.graph, method, "spring-mvc", verb, paths, line);
  }
}

// ---------------------------------------------------------------- JAX-RS

const JAXRS_VERBS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
const jaxrsVerbs = (list: JavaAnnotationInfo[]): JavaAnnotationInfo[] => list.filter((ann) => JAXRS_VERBS.includes(ann.simpleName) && findAnnotations([ann], ann.simpleName, JAXRS).length > 0);
const jaxrsPath = (list: JavaAnnotationInfo[]): JavaAnnotationInfo | undefined => findAnnotations(list, "Path", JAXRS)[0];
const jaxrsRelevant = (list: JavaAnnotationInfo[]): boolean => jaxrsVerbs(list).length > 0 || jaxrsPath(list) !== undefined;

// The class annotations that make `owner` a root resource: its own `@Path`, else that of an interface it
// implements directly (JAX-RS annotation inheritance). A subclass of a `@Path` class is no resource of its
// own without one (the annotation is not @Inherited): it would only duplicate the superclass's routes.
function resourceAnnotations(index: Index, owner: GraphNode): JavaAnnotationInfo[] | null {
  const own = index.reader.annotationsOf(owner);
  if (jaxrsPath(own)) return own;
  for (const parent of index.supertypes.get(owner.id) ?? []) {
    if (parent.label !== "Interface") continue;
    const list = index.reader.annotationsOf(parent);
    if (jaxrsPath(list)) return list;
  }
  return null;
}

function jaxrsRoutes(index: Index, method: JavaMethod, resources: Map<string, JavaAnnotationInfo[] | null>): void {
  if (!isHandlerCandidate(method, "public")) return;
  const { owner, node } = method;
  let classList = resources.get(owner.id);
  if (classList === undefined) {
    classList = resourceAnnotations(index, owner);
    resources.set(owner.id, classList);
  }
  if (!classList) return;
  // JAX-RS: a method with any JAX-RS annotation of its own ignores its supertypes' ones.
  const found = methodAnnotations(index, owner, node, jaxrsRelevant);
  if (!found) return;
  const verbs = jaxrsVerbs(found.list);
  // Only `@Path`: a sub-resource locator, whose routes live in the class it returns. Not a Route.
  if (verbs.length === 0) return;
  const paths = combine(pathsOf(jaxrsPath(classList), ["value"]), pathsOf(jaxrsPath(found.list), ["value"]));
  for (const ann of verbs) emit(index.graph, method, "jaxrs", ann.simpleName, paths, found.own ? ann.line : Number(node.properties.line));
}

// ---------------------------------------------------------------- Micronaut

const MICRONAUT_VERBS: Record<string, string> = { Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE", Patch: "PATCH", Head: "HEAD", Options: "OPTIONS" };

function micronautRoutes(index: Index, method: JavaMethod): void {
  if (!isHandlerCandidate(method, "public")) return;
  const { owner, node } = method;
  const controller = findAnnotations(index.reader.annotationsOf(owner), "Controller", MICRONAUT)[0];
  if (!controller) return;
  // `@Controller` with no value is the root path.
  const prefixes = pathsOf(controller, ["value"]);
  for (const ann of index.reader.annotationsOf(node)) {
    const verb = MICRONAUT_VERBS[ann.simpleName];
    if (!verb || findAnnotations([ann], ann.simpleName, MICRONAUT).length === 0) continue;
    // `value` and `uri` name the one path, `uris` several; none is the controller's own path.
    emit(index.graph, method, "micronaut", verb, combine(prefixes, pathsOf(ann, ["value", "uri", "uris"])), ann.line);
  }
}

export const javaRoutesContributor: ISemanticContributor = {
  id: "java.routes",
  contribute(graph) {
    const index = buildIndex(graph);
    const resources = new Map<string, JavaAnnotationInfo[] | null>();
    for (const method of javaMethods(graph)) {
      springRoutes(index, method);
      jaxrsRoutes(index, method, resources);
      micronautRoutes(index, method);
    }
  },
};
