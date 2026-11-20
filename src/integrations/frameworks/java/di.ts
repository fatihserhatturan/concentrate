import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { createJavaTypeIndex, type JavaType } from "../../languages/java/types.js";
import { annotationValue, findAnnotations, hasAnnotation, javaAnnotationReader, type JavaAnnotationInfo } from "./annotations.js";
import { javaMethods } from "./shared.js";

// Java dependency injection (Spring, JSR-330 / Jakarta `@Inject`), as INJECTS between classes like
// NestJS and Go:
//   - a provider is a non-abstract class with a Spring stereotype (`@Component`, `@Service`,
//     `@Repository`, `@Controller` (Spring's or Micronaut's), `@RestController`, `@Configuration`, `@SpringBootApplication`),
//     `@Named` or `@Singleton`; it gets `diStereotype` and `diBeanName`. A `@Bean` method (in any
//     provider class) provides its return type, named by the method (or `@Bean("a")`): it gets `diBean`;
//   - injection points: the `@Autowired`/`@Inject` constructor (else the only constructor), `@Autowired`,
//     `@Inject` and `@Resource` fields, `@Autowired`/`@Inject` methods (`via` setter) and `@Bean`
//     method parameters (the bean's class, else the declaring configuration class, is the consumer);
//   - `consumer -INJECTS-> provider` with `fieldName` (parameter or field name), `via` (constructor,
//     field, setter, bean-parameter) and `beanMethod` (set when a `@Bean` method is the provider; the
//     edge then goes to the bean's class when it is scanned, else to the configuration class).
// A written type that is a scanned class is the provider itself; an interface or abstract class is the
// providers that implement it (transitively), narrowed by `@Qualifier`/`@Named`/`@Resource(name=)`
// against bean names and qualifiers, then by the one `@Primary`, then by a bean named like the
// field/parameter. Several left: no edge, `ambiguousInjections` on the consumer counts it. `Optional`,
// `ObjectProvider`, `Provider` and `ObjectFactory` are looked through; `List`, `Set`, `Collection`,
// `Map<String, T>` and arrays inject every provider (an edge to each). Types outside the scan
// (`JdbcTemplate`) and scanned types with no provider are neither linked nor counted.
// Not handled: meta-annotations (a custom stereotype), Lombok-generated constructors, Micronaut
// `@Factory`, conditional beans (`@Profile`, `@ConditionalOn*`), generic-type matching.

const STEREOTYPES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["Component", ["org.springframework.stereotype"]],
  ["Service", ["org.springframework.stereotype"]],
  ["Repository", ["org.springframework.stereotype"]],
  ["Controller", ["org.springframework.stereotype"]],
  // Micronaut's `@Controller` is a bean too (its constructor injection points matter); the package check
  // keeps Spring's and Micronaut's apart, and `diStereotype` is just the annotation's simple name.
  ["Controller", ["io.micronaut.http.annotation"]],
  ["RestController", ["org.springframework.web.bind.annotation"]],
  ["Configuration", ["org.springframework.context.annotation"]],
  ["SpringBootApplication", ["org.springframework.boot.autoconfigure"]],
  ["Named", ["javax.inject", "jakarta.inject"]],
  ["Singleton", ["javax.inject", "jakarta.inject"]],
];
const INJECT_PACKAGES = ["javax.inject", "jakarta.inject"];
const RESOURCE_PACKAGES = ["javax.annotation", "jakarta.annotation"];
const SINGLE_WRAPPERS = new Set(["Optional", "ObjectProvider", "Provider", "ObjectFactory"]);
const COLLECTIONS = new Set(["List", "Set", "Collection", "Iterable", "SortedSet"]);

type Via = "constructor" | "field" | "setter" | "bean-parameter";
type AnnotationLike = Pick<JavaAnnotationInfo, "args"> & { simpleName: string };

type Candidate = {
  /** The class an edge goes to. */
  target: GraphNode;
  /** The type the bean has: a class, or the interface a `@Bean` method returns. */
  type: JavaType;
  names: Set<string>;
  qualifiers: Set<string>;
  primary: boolean;
  beanMethod: string | null;
};

type Point = {
  consumer: GraphNode;
  scope: JavaType;
  type: string;
  name: string;
  via: Via;
  annotations: AnnotationLike[];
};

// java.beans.Introspector: `URLService` stays, `UserService` becomes `userService`.
function decapitalize(name: string): string {
  return name.length > 1 && name[0] === name[0]!.toUpperCase() && name[1] === name[1]!.toUpperCase() ? name : name.charAt(0).toLowerCase() + name.slice(1);
}

function literals(ann: AnnotationLike | undefined, key = "value"): { values: string[]; unresolved: boolean } {
  const parsed = ann ? annotationValue(ann, key) : null;
  return { values: (parsed ?? []).filter((v) => v.resolved).map((v) => v.value), unresolved: (parsed ?? []).some((v) => !v.resolved) };
}

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "<") depth += 1;
    else if (text[i] === ">") depth -= 1;
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}

// `Optional<List<Foo>>`: the type to resolve and whether every provider is meant.
function injectedType(written: string): { name: string; many: boolean } | null {
  let text = written.replace(/@[\p{L}\p{N}_$.]+(?:\s*\([^)]*\))?/gu, " ").replace(/\bfinal\b/gu, " ").replace(/\s+/gu, " ").trim();
  let many = false;
  for (let guard = 0; guard < 6; guard += 1) {
    if (text.endsWith("[]")) {
      many = true;
      text = text.slice(0, -2).trim();
      continue;
    }
    const open = text.indexOf("<");
    if (open < 0 || !text.endsWith(">")) break;
    const outer = text.slice(0, open).trim().split(".").at(-1)!;
    const args = splitTop(text.slice(open + 1, -1));
    if (SINGLE_WRAPPERS.has(outer) && args.length === 1) text = args[0]!;
    else if (COLLECTIONS.has(outer) && args.length === 1) {
      many = true;
      text = args[0]!;
    } else if (outer === "Map" && args.length === 2 && /^(?:java\.lang\.)?String$/u.test(args[0]!)) {
      many = true;
      text = args[1]!;
    } else break;
  }
  text = text.replace(/<.*>$/su, "").replace(/\s+/gu, "");
  return /^[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*$/u.test(text) ? { name: text, many } : null;
}

function parameterList(fn: GraphNode): Array<{ name: string; type: string; annotations: AnnotationLike[] }> {
  try {
    const parsed: unknown = JSON.parse(String(fn.properties.parameters ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const parameter = item as { name?: unknown; type?: unknown; annotations?: Array<{ name?: unknown; args?: unknown }> };
      if (typeof parameter.name !== "string" || typeof parameter.type !== "string") return [];
      const annotations = (parameter.annotations ?? []).map((ann) => ({ simpleName: String(ann.name).split(".").at(-1)!, args: Array.isArray(ann.args) ? ann.args.map(String) : [] }));
      return [{ name: parameter.name, type: parameter.type, annotations }];
    });
  } catch {
    return [];
  }
}

export const javaDiContributor: ISemanticContributor = {
  id: "java.di",
  contribute(graph) {
    const reader = javaAnnotationReader(graph);
    const types = createJavaTypeIndex(graph, createResolutionRelationshipIndex(graph));
    const isTestFile = (fileId: string) => graph.node(fileId)?.properties.isTest === true;

    // ---- providers
    const providerTypes = new Map<string, JavaType>();
    const candidates: Candidate[] = [];
    for (const type of types.types) {
      const node = type.node;
      if (type.isInterface || node.label !== "Class" || node.properties.isAbstract === true || node.properties.kind !== "class" || isTestFile(type.fileId)) continue;
      const list = reader.annotationsOf(node);
      const stereotype = STEREOTYPES.find(([name, packages]) => hasAnnotation(list, name, packages));
      if (!stereotype) continue;
      providerTypes.set(type.id, type);
      const stereotypeAnn = findAnnotations(list, stereotype[0], stereotype[1])[0]!;
      // Micronaut's `@Controller("/users")` value is a URI, not a bean name.
      const explicit = stereotype[1][0]!.startsWith("io.micronaut") ? { values: [] as string[], unresolved: false } : literals(stereotypeAnn);
      // @Named("x") beside @Component: either gives the name.
      const named = literals(findAnnotations(list, "Named", INJECT_PACKAGES)[0]);
      const beanName = explicit.values[0] ?? named.values[0] ?? decapitalize(type.name);
      node.properties.diStereotype = stereotype[0];
      node.properties.diBeanName = beanName;
      candidates.push({
        target: node,
        type,
        names: new Set([beanName, ...explicit.values, ...named.values]),
        qualifiers: new Set(findAnnotations(list, "Qualifier").flatMap((ann) => literals(ann).values)),
        primary: hasAnnotation(list, "Primary", ["org.springframework.context.annotation"]),
        beanMethod: null,
      });
    }

    const points: Point[] = [];
    const methodsByOwner = new Map<string, GraphNode[]>();
    for (const { node, owner } of javaMethods(graph)) {
      if (!providerTypes.has(owner.id)) continue;
      const list = methodsByOwner.get(owner.id);
      if (list) list.push(node);
      else methodsByOwner.set(owner.id, [node]);
    }

    for (const [ownerId, methods] of methodsByOwner) {
      const owner = providerTypes.get(ownerId)!;
      // ---- @Bean methods: providers, and injection points for their parameters.
      for (const method of methods) {
        if (method.properties.kind !== "method") continue;
        const list = reader.annotationsOf(method);
        const bean = findAnnotations(list, "Bean", ["org.springframework.context.annotation"])[0];
        if (!bean) continue;
        const declared = literals(bean, "name").values.length > 0 ? literals(bean, "name") : literals(bean);
        const names = declared.values.length > 0 ? declared.values : [String(method.properties.name)];
        method.properties.diBean = names[0]!;
        const returned = injectedType(String(method.properties.returnType ?? ""));
        const returnType = returned && !returned.many ? types.resolve(returned.name, { fileId: owner.fileId, typeId: owner.id }) : null;
        // A bean of a type outside the scan is nobody's dependency; its parameters still are the config class's.
        const beanClass = returnType && !returnType.isInterface ? returnType : null;
        if (returnType) {
          candidates.push({
            target: beanClass ? beanClass.node : owner.node,
            type: returnType,
            names: new Set(names),
            qualifiers: new Set(findAnnotations(list, "Qualifier").flatMap((ann) => literals(ann).values)),
            primary: hasAnnotation(list, "Primary", ["org.springframework.context.annotation"]),
            beanMethod: String(method.properties.name),
          });
        }
        for (const parameter of parameterList(method)) {
          points.push({ consumer: beanClass ? beanClass.node : owner.node, scope: owner, type: parameter.type, name: parameter.name, via: "bean-parameter", annotations: parameter.annotations });
        }
      }

      // ---- constructor: the annotated one, else the only one.
      const constructors = methods.filter((method) => method.properties.kind === "constructor");
      const isAutowired = (list: readonly JavaAnnotationInfo[]) => hasAnnotation(list, "Autowired", ["org.springframework.beans.factory.annotation"]) || hasAnnotation(list, "Inject", INJECT_PACKAGES);
      const annotated = constructors.filter((ctor) => isAutowired(reader.annotationsOf(ctor)));
      const chosen = annotated.length === 1 ? annotated[0] : annotated.length === 0 && constructors.length === 1 ? constructors[0] : undefined;
      if (chosen) {
        for (const parameter of parameterList(chosen)) {
          points.push({ consumer: owner.node, scope: owner, type: parameter.type, name: parameter.name, via: "constructor", annotations: parameter.annotations });
        }
      }

      // ---- @Autowired / @Inject methods.
      for (const method of methods) {
        if (method.properties.kind !== "method") continue;
        const list = reader.annotationsOf(method);
        if (!isAutowired(list) || hasAnnotation(list, "Bean")) continue;
        for (const parameter of parameterList(method)) {
          points.push({ consumer: owner.node, scope: owner, type: parameter.type, name: parameter.name, via: "setter", annotations: [...parameter.annotations, ...list] });
        }
      }
    }

    // ---- fields
    for (const rel of graph.relationshipsOfType("DEFINES_FIELD")) {
      const owner = providerTypes.get(rel.from);
      const field = graph.node(rel.to);
      if (!owner || !field || field.properties.isStatic === true || typeof field.properties.declaredType !== "string") continue;
      const list = reader.annotationsOf(field);
      const injected = hasAnnotation(list, "Autowired", ["org.springframework.beans.factory.annotation"]) || hasAnnotation(list, "Inject", INJECT_PACKAGES) || hasAnnotation(list, "Resource", RESOURCE_PACKAGES);
      if (!injected) continue;
      points.push({ consumer: owner.node, scope: owner, type: field.properties.declaredType, name: String(field.properties.name), via: "field", annotations: list });
    }

    // ---- resolution
    const added = new Set<string>();
    const relationships: GraphRelationship[] = [];
    const ambiguous = new Map<string, number>();
    const link = (point: Point, candidate: Candidate) => {
      if (point.consumer.id === candidate.target.id) return;
      const key = `${point.consumer.id}\0${candidate.target.id}\0${point.name}\0${point.via}`;
      if (added.has(key)) return;
      added.add(key);
      relationships.push({
        from: point.consumer.id,
        to: candidate.target.id,
        type: "INJECTS",
        properties: { fieldName: point.name, via: point.via, ...(candidate.beanMethod ? { beanMethod: candidate.beanMethod } : {}) },
      });
    };

    for (const point of points) {
      const written = injectedType(point.type);
      if (!written) continue;
      const wanted = types.resolve(written.name, { fileId: point.scope.fileId, typeId: point.scope.id });
      if (!wanted) continue;
      // A provider is of the wanted type when it is that type or one of its subtypes.
      const accepted = new Set([wanted.id, ...types.subtypes(wanted).map((type) => type.id)]);
      let matches = candidates.filter((candidate) => accepted.has(candidate.type.id));
      if (matches.length === 0) continue;
      if (written.many) {
        for (const match of matches) link(point, match);
        continue;
      }
      if (new Set(matches.map((match) => match.target.id)).size === 1) {
        link(point, matches[0]!);
        continue;
      }

      // Several providers: qualifier, then @Primary, then the bean named like the point.
      const qualifierAnns = point.annotations.filter((ann) => ann.simpleName === "Qualifier" || ann.simpleName === "Named");
      const resource = point.annotations.find((ann) => ann.simpleName === "Resource");
      const requested = [...qualifierAnns.map((ann) => literals(ann)), ...(resource ? [literals(resource, "name")] : [])];
      const qualifierNames = requested.flatMap((entry) => entry.values);
      if (qualifierNames.length > 0 || requested.some((entry) => entry.unresolved)) {
        if (requested.some((entry) => entry.unresolved)) {
          ambiguous.set(point.consumer.id, (ambiguous.get(point.consumer.id) ?? 0) + 1);
          continue;
        }
        matches = matches.filter((match) => qualifierNames.every((name) => match.names.has(name) || match.qualifiers.has(name)));
      } else {
        const primary = matches.filter((match) => match.primary);
        if (primary.length > 0) matches = primary;
        else {
          const byName = matches.filter((match) => match.names.has(point.name));
          if (byName.length > 0) matches = byName;
        }
      }
      if (matches.length === 0) continue;
      if (new Set(matches.map((match) => match.target.id)).size === 1) link(point, matches[0]!);
      else ambiguous.set(point.consumer.id, (ambiguous.get(point.consumer.id) ?? 0) + 1);
    }

    for (const relationship of relationships) graph.addRelationship(relationship);
    for (const [consumerId, count] of ambiguous) {
      const consumer = graph.node(consumerId);
      if (consumer) consumer.properties.ambiguousInjections = count;
    }
  },
};
