// Rust type text → the name of the type a method call on it lands on.

const wrappers = new Set(["Box", "Arc", "Rc", "RefCell", "Cell", "Mutex", "RwLock", "Pin", "Cow", "ManuallyDrop"]);
const markerTraits = new Set(["Send", "Sync", "Sized", "Unpin", "Copy", "Clone", "Debug", "'static"]);

// `&mut Foo`, `Arc<Mutex<Foo>>`, `dyn Shape + Send`, `a::b::Foo<T>`, `Self` →
// `Foo`, `Foo`, `Shape`, `Foo`, the impl's type. A type parameter gives its
// trait bounds joined by `+` (`T: Shape + Display` → `Shape+Display`); tuples,
// arrays, slices, functions and raw pointers give null.
export function rustBaseType(text: string, bounds: ReadonlyMap<string, string> = new Map(), selfType: string | null = null, depth = 0): string | null {
  if (depth > 6) return null;
  let value = text.trim();
  for (;;) {
    const reference = /^&\s*(?:'\w+\s+)?(?:mut\s+)?/u.exec(value);
    if (reference && reference[0].length > 0) {
      value = value.slice(reference[0].length).trim();
      continue;
    }
    if (value.startsWith("mut ")) {
      value = value.slice(4).trim();
      continue;
    }
    break;
  }
  const traitObject = /^(?:dyn|impl)\s+(.*)$/su.exec(value);
  if (traitObject) {
    const names = splitTop(traitObject[1]!, "+")
      .map((part) => rustBaseType(part, bounds, selfType, depth + 1))
      .filter((name): name is string => name !== null && !markerTraits.has(name));
    return names.length > 0 ? names.join("+") : null;
  }
  const match = /^([A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)*)\s*(?:<(.*)>)?$/su.exec(value);
  if (!match) return null;
  const name = match[1]!.split("::").at(-1)!;
  const args = match[2];
  if (wrappers.has(name) && args) {
    const first = splitTop(args, ",").find((part) => !part.startsWith("'"));
    return first ? rustBaseType(first, bounds, selfType, depth + 1) : null;
  }
  if (name === "Self") return selfType;
  const bound = bounds.get(name);
  if (bound !== undefined) return bound;
  return name;
}

export function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if ("<([{".includes(char)) depth += 1;
    else if (">)]}".includes(char) && !(char === ">" && text[index - 1] === "-")) depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part !== "");
}

// `Result<Foo, E>` / `Option<Foo>` → `Foo`; anything else → its base type.
export function unwrapResultType(text: string, selfType: string | null): string | null {
  const match = /^(?:\w+::)*(?:Result|Option)\s*<(.*)>$/su.exec(text.trim());
  if (!match) return rustBaseType(text, new Map(), selfType);
  const first = splitTop(match[1]!, ",")[0];
  return first ? rustBaseType(first, new Map(), selfType) : null;
}
