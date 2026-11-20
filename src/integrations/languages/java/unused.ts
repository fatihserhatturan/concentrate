import path from "node:path";
import type { IUnusedExportRules } from "../../../core/contracts/unused-rules.js";
import { isJavaFile } from "../file-kind.js";

// Annotations that say nothing about who calls the declaration. Any other annotation (`@Bean`,
// `@Inject`, `@PostConstruct`, `@Test`, …) means a framework may call it.
const HARMLESS_ANNOTATIONS = new Set(["Deprecated", "SuppressWarnings", "SafeVarargs", "FunctionalInterface", "SuppressFBWarnings"]);

// Methods the JDK's serialization calls by name.
const SERIALIZATION_METHODS = new Set(["readObject", "writeObject", "readObjectNoData", "readResolve", "writeReplace"]);

// Comments out, string and character literals kept (a name in a string may be a reflective use).
export function stripJavaComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      out += " ";
    } else if (c === "\"" && text.startsWith("\"\"\"", i)) {
      const end = text.indexOf("\"\"\"", i + 3);
      const stop = end < 0 ? text.length : end + 3;
      out += text.slice(i, stop);
      i = stop;
    } else if (c === "\"" || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// name -> scope key -> count. A scope is a file (`f:path`, for private members) or a package (`u:unit`).
type Counts = Map<string, Map<string, number>>;

function bump(counts: Counts, name: string, key: string): void {
  let byKey = counts.get(name);
  if (!byKey) counts.set(name, byKey = new Map());
  byKey.set(key, (byKey.get(key) ?? 0) + 1);
}

// Java: only what leaves its package is public API. `public` and `protected` types, methods and
// fields are kept; package-private and `private` ones are candidates, and one is used when its name
// is written anywhere beside its declaration in its file (private) or package (package-private,
// tests included). Names stand for the graph's call edges here: overloads, same-named members and
// uses in strings keep a declaration from being reported, never the other way round.
export const javaUnusedRules: IUnusedExportRules = {
  id: "java",
  languages: ["java"],
  supports: isJavaFile,
  usesAnnotations: true,
  // A package is one unit, whatever source root holds its files; the default package is its directory.
  unitOf: (file, info) => (info?.packageName ? info.packageName : path.posix.dirname(file.split("\\").join("/"))),
  // Package-private and private types, methods and fields (anonymous classes, named `Outer$1`, are no candidates).
  judges: (declaration) => ["class", "interface", "method", "field"].includes(declaration.kind)
    && !/[$<]/u.test(declaration.name)
    && !declaration.testKind
    && declaration.visibility !== "public" && declaration.visibility !== "protected",
  async createSession(context) {
    const counts: Counts = new Map();
    // `Name(` that is no `new Name(` and no `.name(`: a constructor's own declaration, for types.
    const constructors: Counts = new Map();
    await context.forEachSource(isJavaFile, (file, text) => {
      const code = stripJavaComments(text);
      const fileKey = `f:${file}`;
      const unitKey = `u:${context.unitOf(file)}`;
      for (const [name] of code.matchAll(/[\p{L}_$][\p{L}\p{N}_$]*/gu)) {
        bump(counts, name, fileKey);
        bump(counts, name, unitKey);
      }
      for (const match of code.matchAll(/(?<!\bnew\s+)(?<![\p{L}\p{N}_$.])(\p{Lu}[\p{L}\p{N}_$]*)\s*\(/gu)) {
        bump(constructors, match[1]!, fileKey);
        bump(constructors, match[1]!, unitKey);
      }
    });
    return {
      isMentionedElsewhere(declaration) {
        const annotations = context.annotationsOf(declaration.id);
        // `@Override` is among them: it never counts as unused.
        if (annotations.some((name) => !HARMLESS_ANNOTATIONS.has(name.slice(name.lastIndexOf(".") + 1)))) return true;
        if (declaration.kind === "method") {
          if (declaration.nodeKind !== "method" || SERIALIZATION_METHODS.has(declaration.name)) return true;
        }
        if (declaration.kind === "field" && (declaration.name === "serialVersionUID" || (declaration.nodeKind !== "field" && declaration.nodeKind !== "constant"))) return true;
        const file = declaration.file;
        const key = declaration.visibility === "private" ? `f:${file}` : `u:${context.unitOf(file)}`;
        const isType = declaration.kind === "class" || declaration.kind === "interface";
        const mentions = (counts.get(declaration.name)?.get(key) ?? 0) - (isType ? constructors.get(declaration.name)?.get(key) ?? 0 : 0);
        return mentions > 1;
      },
    };
  },
  note: "Java: public and protected types, methods and fields are public API and not judged; package-private and private types, methods and fields count as used when their name is written elsewhere in their file (private) or package (package-private, tests included); @Override and annotated members (a framework may call them), constructors, serialization hooks, main entry points, enum constants, record components and interface members are skipped, and reflection or uses outside the repository are not seen.",
};
