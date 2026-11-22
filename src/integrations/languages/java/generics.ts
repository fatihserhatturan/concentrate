// Generic type arguments of Java types as written (`Optional<Limiter.Listener>`), and what a few well-known
// JDK generics do with them. Conservative: anything not listed here is unknown and resolves to nothing.

export type ParsedType = { name: string; args: Array<ParsedType | null> };

// `Map<String, List<T>>` as a tree. A wildcard `? extends X` is X; `?` and `? super X` are unknown (null).
// Null for text that is not a plain (possibly parameterized) type: arrays of generics, `Outer<X>.Inner`.
export function parseGeneric(text: string): ParsedType | null {
  const tokens = text.replace(/@[\p{L}\p{N}_$.]+(?:\s*\([^)]*\))?/gu, " ").match(/[\p{L}\p{N}_$]+|[<>,.?[\]&]/gu) ?? [];
  let position = 0;
  const parseType = (): ParsedType | null | undefined => {
    const token = tokens[position];
    if (token === undefined) return undefined;
    if (token === "?") {
      position += 1;
      if (tokens[position] === "extends") {
        position += 1;
        return parseType();
      }
      if (tokens[position] === "super") {
        position += 1;
        const skipped = parseType();
        return skipped === undefined ? undefined : null;
      }
      return null;
    }
    if (!/^[\p{L}_$]/u.test(token)) return undefined;
    let name = token;
    position += 1;
    while (tokens[position] === "." && tokens[position + 1] !== undefined && /^[\p{L}_$]/u.test(tokens[position + 1]!)) {
      name += `.${tokens[position + 1]}`;
      position += 2;
    }
    const args: Array<ParsedType | null> = [];
    if (tokens[position] === "<") {
      position += 1;
      if (tokens[position] === ">") {
        position += 1;
      } else {
        for (;;) {
          const argument = parseType();
          if (argument === undefined) return undefined;
          args.push(argument);
          if (tokens[position] === ",") {
            position += 1;
            continue;
          }
          if (tokens[position] === ">") {
            position += 1;
            break;
          }
          return undefined;
        }
      }
      if (tokens[position] === ".") return undefined;
    }
    if (tokens[position] === "[" && tokens[position + 1] === "]") {
      position += 2;
      return { name: `${name}[]`, args: [] };
    }
    return { name, args };
  };
  const parsed = parseType();
  return parsed && position === tokens.length ? parsed : null;
}

const packageByName: Record<string, string> = {
  Optional: "java.util",
  List: "java.util",
  Set: "java.util",
  Collection: "java.util",
  Iterable: "java.lang",
  Stream: "java.util.stream",
  Function: "java.util.function",
  BiFunction: "java.util.function",
  Predicate: "java.util.function",
  BiPredicate: "java.util.function",
  Consumer: "java.util.function",
  BiConsumer: "java.util.function",
  Supplier: "java.util.function",
  UnaryOperator: "java.util.function",
  BinaryOperator: "java.util.function",
};

/** The package a known JDK generic belongs to (`Optional` is `java.util`), or null for any other name. */
export function jdkPackageOf(simpleName: string): string | null {
  return Object.hasOwn(packageByName, simpleName) ? packageByName[simpleName]! : null;
}

// Which type argument is the type of each parameter of the functional interface's method.
const functionalParameters: Record<string, readonly number[]> = {
  Function: [0],
  BiFunction: [0, 1],
  Predicate: [0],
  BiPredicate: [0, 1],
  Consumer: [0],
  BiConsumer: [0, 1],
  UnaryOperator: [0],
  BinaryOperator: [0, 0],
  Supplier: [],
};

/** The index of the type argument that types lambda parameter `param` of a `Function`, `Predicate`, ... (null: unknown). */
export function jdkFunctionalParameter(name: string, param: number): number | null {
  return functionalParameters[name]?.[param] ?? null;
}

// Methods whose functional argument takes the element of the receiver (the first type argument) as its only parameter.
const elementMethods: Record<string, ReadonlySet<string>> = {
  Optional: new Set(["map", "ifPresent", "flatMap", "filter"]),
  Stream: new Set(["map", "filter", "forEach", "anyMatch", "allMatch", "noneMatch", "flatMap", "peek", "takeWhile", "dropWhile"]),
  List: new Set(["forEach", "removeIf"]),
  Set: new Set(["forEach", "removeIf"]),
  Collection: new Set(["forEach", "removeIf"]),
  Iterable: new Set(["forEach"]),
};

export function jdkElementMethods(name: string, callee: string): boolean {
  return elementMethods[name]?.has(callee) === true;
}

/** The index of the type argument a JDK method returns (`Optional<T>.get()` is 0), or null (unknown). */
export function jdkResultOf(name: string, method: string, argumentCount: number): number | null {
  if (name === "Optional" && argumentCount === 0 && (method === "get" || method === "orElseThrow")) return 0;
  if (name === "Optional" && argumentCount === 1 && (method === "orElse" || method === "orElseGet" || method === "orElseThrow")) return 0;
  if (name === "List" && argumentCount === 1 && method === "get") return 0;
  return null;
}
