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
// `Map<String, T>` and arrays inject every provider (an edge to each); the `T` of a map must be a plain
// type (`Map<String, List<A>>` injects nothing). Types outside the scan (`JdbcTemplate`) and scanned
// types with no provider are neither linked nor counted. The consumer itself is no candidate while another
// exists (Spring's self-injection fallback).
// Bean names: an explicit name that is not a string literal (`@Component(Names.X)`, `@Bean(NAME)`) leaves
// the bean without a known name (`diBeanName` / `diBean` unset); such a bean can win no qualifier or
// by-name decision and, being a possible match, makes the point count as ambiguous.
// `@Resource` without `name` resolves by the field (or setter property) name first, even against
// `@Primary`, then by type.
// Generics: when the injection point has type arguments (`Handler<Integer>`), a provider must write the
// same arguments (whitespace and package prefixes ignored) in the `extends`/`implements` clause that names
// the wanted type directly; different arguments exclude it, a raw or indirect supertype (through an
// interface, whose arguments the graph does not keep) is not provable: excluded, and the point counted
// when that leaves no decision. Wildcard arguments (`Handler<?>`) are not provable either.
// Not handled: meta-annotations (a custom stereotype), Lombok-generated constructors, Micronaut
// `@Factory`, conditional beans (`@Profile`, `@ConditionalOn*`), type variables of generic providers.

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
  /** An explicit name was written but is not a string literal: the bean's name is unknown, never guessed. */
  nameUnknown: boolean;
  qualifiers: Set<string>;
  primary: boolean;
  beanMethod: string | null;
  /** The written type of a `@Bean` method's return (with its type arguments); null for a class provider. */
  returnText: string | null;
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

const GENERIC_WRAPPERS = new Set([...SINGLE_WRAPPERS, ...COLLECTIONS, "Map"]);

// `Optional<List<Foo>>`: the type to resolve, whether every provider is meant, and the type arguments
// written on it (`Handler<String>` -> ["String"]; null when it has none).
function injectedType(written: string): { name: string; many: boolean; args: string[] | null } | null {
  let text = written.replace(/@[\p{L}\p{N}_$.]+(?:\s*\([^)]*\))?/gu, " ").replace(/\bfinal\b/gu, " ").replace(/\s+/gu, " ").trim();
  let many = false;
  let mapValue = false;
  for (let guard = 0; guard < 6 && !mapValue; guard += 1) {
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
      mapValue = true;
      text = args[1]!;
    } else break;
  }
  if (mapValue) {
    // The value of a map is a plain type: no further collection, wrapper, map or array.
    const outer = text.replace(/<.*$/su, "").trim().split(".").at(-1)!;
    if (text.endsWith("[]") || GENERIC_WRAPPERS.has(outer)) return null;
  }
  const open = text.indexOf("<");
  const args = open >= 0 && text.endsWith(">") ? splitTop(text.slice(open + 1, -1)) : null;
  text = text.replace(/<.*>$/su, "").replace(/\s+/gu, "");
  return /^[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*$/u.test(text) ? { name: text, many, args } : null;
}

// `java.util.List< String >` and `List<String>` compare equal: no whitespace, no package prefixes.
function normalizeArgument(text: string): string {
  return text.replace(/@[\p{L}\p{N}_$.]+(?:\s*\([^)]*\))?/gu, " ").replace(/\s+/gu, "").replace(/(?:[\p{L}_$][\p{L}\p{N}_$]*\.)+(?=[\p{L}_$])/gu, "");
}

function sameArguments(wanted: readonly string[], provided: readonly string[]): boolean {
  return wanted.length === provided.length && wanted.every((arg, index) => normalizeArgument(arg) === normalizeArgument(provided[index]!));
}

// The type arguments of `Handler<String, Long>` as written; null for a raw type.
function argumentsOfText(text: string): string[] | null {
  const open = text.indexOf("<");
  return open >= 0 && text.trimEnd().endsWith(">") ? splitTop(text.slice(open + 1, text.trimEnd().length - 1)) : null;
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
      // An explicit name that is no literal leaves the name unknown; the class name is only the default
      // of a bean with no explicit name at all.
      const nameUnknown = explicit.values.length === 0 && named.values.length === 0 && (explicit.unresolved || named.unresolved);
      const beanName = explicit.values[0] ?? named.values[0] ?? (nameUnknown ? null : decapitalize(type.name));
      node.properties.diStereotype = stereotype[0];
      if (beanName !== null) node.properties.diBeanName = beanName;
      candidates.push({
        target: node,
        type,
        names: new Set([...(beanName === null ? [] : [beanName]), ...explicit.values, ...named.values]),
        nameUnknown,
        returnText: null,
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
        const byKey = literals(bean, "name");
        const declared = byKey.values.length > 0 || byKey.unresolved ? byKey : literals(bean);
        const nameUnknown = declared.values.length === 0 && declared.unresolved;
        const names = declared.values.length > 0 ? declared.values : nameUnknown ? [] : [String(method.properties.name)];
        if (names.length > 0) method.properties.diBean = names[0]!;
        const returned = injectedType(String(method.properties.returnType ?? ""));
        const returnType = returned && !returned.many ? types.resolve(returned.name, { fileId: owner.fileId, typeId: owner.id }) : null;
        // A bean of a type outside the scan is nobody's dependency; its parameters still are the config class's.
        const beanClass = returnType && !returnType.isInterface ? returnType : null;
        if (returnType) {
          candidates.push({
            target: beanClass ? beanClass.node : owner.node,
            type: returnType,
            names: new Set(names),
            nameUnknown,
            returnText: String(method.properties.returnType ?? ""),
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
        if (hasAnnotation(list, "Bean")) continue;
        if (hasAnnotation(list, "Resource", RESOURCE_PACKAGES) && !isAutowired(list)) {
          // `@Resource` on `setFoo(Foo foo)`: the property `foo` is the name to look for.
          const setter = /^set([\p{Lu}][\p{L}\p{N}_$]*)$/u.exec(String(method.properties.name));
          const parameters = parameterList(method);
          if (setter && parameters.length === 1) points.push({ consumer: owner.node, scope: owner, type: parameters[0]!.type, name: decapitalize(setter[1]!), via: "setter", annotations: [...parameters[0]!.annotations, ...list] });
          continue;
        }
        if (!isAutowired(list)) continue;
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

    // The type arguments `candidate` gives `wanted`: written in its own `extends` / `implements` clause (a
    // class provider) or in the return type of its `@Bean` method. "match" / "mismatch" are proven;
    // "unknown" is a raw type, an indirect supertype or a wildcard.
    const bases = new Map<string, Array<{ name: string; text: string }>>();
    const basesOf = (type: JavaType) => {
      let list = bases.get(type.id);
      if (!list) {
        list = [];
        try {
          const parsed: unknown = JSON.parse(String(type.node.properties.bases ?? "[]"));
          if (Array.isArray(parsed)) for (const base of parsed as Array<{ name?: unknown; text?: unknown }>) if (typeof base.name === "string" && typeof base.text === "string") list.push({ name: base.name, text: base.text });
        } catch {
          // Unreadable bases count as none.
        }
        bases.set(type.id, list);
      }
      return list;
    };
    const genericFit = (candidate: Candidate, wanted: JavaType, wantedArgs: readonly string[]): "match" | "mismatch" | "unknown" => {
      if (wantedArgs.some((arg) => arg.startsWith("?"))) return "unknown";
      let provided: string[] | null | undefined;
      if (candidate.returnText !== null && candidate.type.id === wanted.id) provided = argumentsOfText(candidate.returnText);
      else if (candidate.returnText === null && candidate.type.id === wanted.id) return "match"; // the generic class itself
      else {
        const direct = basesOf(candidate.type).find((base) => types.resolve(base.name, { fileId: candidate.type.fileId, typeId: candidate.type.id })?.id === wanted.id);
        provided = direct ? argumentsOfText(direct.text) : undefined;
      }
      if (!provided || provided.some((arg) => arg.startsWith("?"))) return "unknown";
      return sameArguments(wantedArgs, provided) ? "match" : "mismatch";
    };

    const countAmbiguous = (consumer: GraphNode) => ambiguous.set(consumer.id, (ambiguous.get(consumer.id) ?? 0) + 1);

    for (const point of points) {
      const written = injectedType(point.type);
      if (!written) continue;
      const wanted = types.resolve(written.name, { fileId: point.scope.fileId, typeId: point.scope.id });
      if (!wanted) continue;
      // A provider is of the wanted type when it is that type or one of its subtypes.
      const accepted = new Set([wanted.id, ...types.subtypes(wanted).map((type) => type.id)]);
      let matches = candidates.filter((candidate) => accepted.has(candidate.type.id));
      if (matches.length === 0) continue;

      // Type arguments of the point (`Handler<Integer>`) must be the provider's.
      let unprovable = false;
      if (written.args && written.args.length > 0) {
        const fits = matches.map((candidate) => ({ candidate, fit: genericFit(candidate, wanted, written.args!) }));
        unprovable = fits.some((entry) => entry.fit === "unknown");
        matches = fits.filter((entry) => entry.fit === "match").map((entry) => entry.candidate);
      }
      // The consumer is no candidate for itself while another one exists.
      const others = matches.filter((match) => match.target.id !== point.consumer.id);
      if (others.length > 0) matches = others;
      if (matches.length === 0) {
        if (unprovable) countAmbiguous(point.consumer);
        continue;
      }
      if (written.many) {
        for (const match of matches) link(point, match);
        continue;
      }
      if (new Set(matches.map((match) => `${match.target.id}\0${match.beanMethod ?? ""}`)).size === 1) {
        link(point, matches[0]!);
        continue;
      }

      // Several providers: qualifier, then @Primary, then the bean named like the point. A provider whose
      // name is unknown might be any of them: the decision is then not safe.
      const qualifierAnns = point.annotations.filter((ann) => ann.simpleName === "Qualifier" || ann.simpleName === "Named");
      const resource = point.annotations.find((ann) => ann.simpleName === "Resource");
      const resourceName = resource ? literals(resource, "name") : null;
      const requested = [...qualifierAnns.map((ann) => literals(ann)), ...(resourceName ? [resourceName] : [])];
      const qualifierNames = requested.flatMap((entry) => entry.values);
      const resourceByPointName = resource !== undefined && resourceName!.values.length === 0 && !resourceName!.unresolved && qualifierAnns.length === 0;
      if (qualifierNames.length > 0 || requested.some((entry) => entry.unresolved)) {
        if (requested.some((entry) => entry.unresolved) || matches.some((match) => match.nameUnknown)) {
          countAmbiguous(point.consumer);
          continue;
        }
        matches = matches.filter((match) => qualifierNames.every((name) => match.names.has(name) || match.qualifiers.has(name)));
      } else if (resourceByPointName) {
        // @Resource: the bean named like the field (or setter property) first, before @Primary, then the type.
        if (matches.some((match) => match.nameUnknown)) {
          countAmbiguous(point.consumer);
          continue;
        }
        const byName = matches.filter((match) => match.names.has(point.name));
        if (byName.length > 0) matches = byName;
        else {
          const primary = matches.filter((match) => match.primary);
          if (primary.length > 0) matches = primary;
        }
      } else {
        const primary = matches.filter((match) => match.primary);
        if (primary.length > 0) matches = primary;
        else {
          if (matches.some((match) => match.nameUnknown)) {
            countAmbiguous(point.consumer);
            continue;
          }
          const byName = matches.filter((match) => match.names.has(point.name));
          if (byName.length > 0) matches = byName;
        }
      }
      if (matches.length === 0) continue;
      if (new Set(matches.map((match) => `${match.target.id}\0${match.beanMethod ?? ""}`)).size === 1) link(point, matches[0]!);
      else countAmbiguous(point.consumer);
    }

    for (const relationship of relationships) graph.addRelationship(relationship);
    for (const [consumerId, count] of ambiguous) {
      const consumer = graph.node(consumerId);
      if (consumer) consumer.properties.ambiguousInjections = count;
    }
  },
};
