import type { SyntaxNode } from "../syntax/tree-sitter.js";

export type PythonParameter = { name: string; type: string | null; default?: true };
export type PythonField = { name: string; type: string | null; default?: true };

// `(self, a: int, b=1, *args, c: str = "x", **kw)` as [{name, type, default?}].
// `*` and `/` separators are not parameters.
export function pythonParameters(list: SyntaxNode | null): PythonParameter[] {
  const parameters: PythonParameter[] = [];
  for (const child of list?.namedChildren ?? []) {
    switch (child.type) {
      case "identifier":
        parameters.push({ name: child.text, type: null });
        break;
      case "typed_parameter": {
        const inner = child.namedChildren.find((candidate) => candidate.type !== "type");
        const name = inner ? splatName(inner) : null;
        if (name) parameters.push({ name, type: child.childForFieldName("type")?.text ?? null });
        break;
      }
      case "default_parameter":
      case "typed_default_parameter": {
        const name = child.childForFieldName("name")?.text;
        if (name) parameters.push({ name, type: child.childForFieldName("type")?.text ?? null, default: true });
        break;
      }
      case "list_splat_pattern":
      case "dictionary_splat_pattern": {
        const name = splatName(child);
        if (name) parameters.push({ name, type: null });
        break;
      }
      default:
        break;
    }
  }
  return parameters;
}

function splatName(node: SyntaxNode): string | null {
  if (node.type === "identifier") return node.text;
  if (node.type === "list_splat_pattern") return `*${node.namedChildren[0]?.text ?? ""}`;
  if (node.type === "dictionary_splat_pattern") return `**${node.namedChildren[0]?.text ?? ""}`;
  return null;
}

export type PythonDecorator = { name: string; expression: string; args: string[]; line: number };

// The `@…` lines above a `def` or `class`: `@app.get("/x", status=200)` is
// name `app.get`, args [`"/x"`, `status=200`].
export function decoratorsOf(definition: SyntaxNode): PythonDecorator[] {
  const parent = definition.parent;
  if (!parent || parent.type !== "decorated_definition") return [];
  return parent.namedChildren.filter((child) => child.type === "decorator").map((decorator) => {
    const inner = decorator.namedChildren[0];
    if (inner?.type === "call") {
      const args = inner.childForFieldName("arguments")?.namedChildren.filter((arg) => arg.type !== "comment").map((arg) => arg.text) ?? [];
      return { name: compact(inner.childForFieldName("function")?.text ?? inner.text), expression: decorator.text, args, line: decorator.startPosition.row + 1 };
    }
    return { name: compact(inner?.text ?? decorator.text.replace(/^@/u, "")), expression: decorator.text, args: [], line: decorator.startPosition.row + 1 };
  });
}

function compact(text: string): string {
  return text.replace(/\s+/gu, "");
}

export type PythonBases = { names: string[]; metaclass: string | null };

// `class A(B, mod.C, Generic[T], metaclass=Meta)`: base names without type arguments.
export function classBases(node: SyntaxNode): PythonBases {
  const names: string[] = [];
  let metaclass: string | null = null;
  for (const child of node.childForFieldName("superclasses")?.namedChildren ?? []) {
    if (child.type === "keyword_argument") {
      if (child.childForFieldName("name")?.text === "metaclass") metaclass = child.childForFieldName("value")?.text ?? null;
    } else if (child.type === "identifier" || child.type === "attribute") {
      names.push(child.text);
    } else if (child.type === "subscript") {
      const value = child.childForFieldName("value")?.text;
      if (value) names.push(value);
    }
  }
  return { names, metaclass };
}

const lastSegment = (name: string) => name.split(".").at(-1) ?? name;
const hasBase = (bases: PythonBases, wanted: string) => bases.names.some((name) => lastSegment(name) === wanted);

export type PythonClassKind = "protocol" | "abc" | "dataclass" | "attrs" | "namedtuple" | "typeddict" | "pydantic" | "enum" | null;

// What the class is, from its own bases and decorators (a subclass of a user
// model is not followed: it keeps no kind).
export function classKind(bases: PythonBases, decorators: PythonDecorator[]): PythonClassKind {
  if (hasBase(bases, "Protocol")) return "protocol";
  if (hasBase(bases, "ABC") || (bases.metaclass !== null && lastSegment(bases.metaclass) === "ABCMeta")) return "abc";
  const decoratorNames = decorators.map((decorator) => decorator.name);
  if (decoratorNames.some((name) => /^(?:dataclasses\.)?dataclass$/u.test(name))) return "dataclass";
  if (decoratorNames.some((name) => /^(?:attr|attrs)\.(?:s|attrs|define|frozen|mutable|dataclass)$|^(?:define|frozen|mutable)$/u.test(name))) return "attrs";
  if (hasBase(bases, "NamedTuple")) return "namedtuple";
  if (hasBase(bases, "TypedDict")) return "typeddict";
  if (bases.names.some((name) => ["BaseModel", "BaseSettings", "SQLModel", "RootModel"].includes(lastSegment(name)))) return "pydantic";
  if (bases.names.some((name) => ["Enum", "IntEnum", "StrEnum", "Flag", "IntFlag"].includes(lastSegment(name)))) return "enum";
  return null;
}

// Annotated assignments of a class body (`name: Type = default`), as fields.
// `ClassVar` annotations are not instance fields; for attrs, `x = attr.ib()`
// counts too.
export function classFields(body: SyntaxNode | null, kind: PythonClassKind): PythonField[] {
  const fields: PythonField[] = [];
  if (!body) return fields;
  for (const statement of body.namedChildren) {
    if (statement.type !== "expression_statement") continue;
    const assignment = statement.namedChildren[0];
    if (!assignment || assignment.type !== "assignment") continue;
    const left = assignment.childForFieldName("left");
    if (!left || left.type !== "identifier") continue;
    const type = assignment.childForFieldName("type")?.text ?? null;
    if (type !== null) {
      if (/^(?:typing\.)?ClassVar\b/u.test(type)) continue;
      fields.push({ name: left.text, type, ...(assignment.childForFieldName("right") ? { default: true as const } : {}) });
    } else if (kind === "attrs" && /^(?:attr\.|attrs\.)?(?:ib|attrib|field)\(/u.test(assignment.childForFieldName("right")?.text ?? "")) {
      fields.push({ name: left.text, type: null, default: true });
    }
  }
  return fields;
}
