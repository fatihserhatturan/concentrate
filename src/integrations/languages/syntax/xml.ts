// A small XML element reader for `pom.xml`, `.csproj` and MSBuild `.props` files: elements, their text, attributes and the line
// each element starts on. Comments, the `<?xml?>` prolog, processing instructions, `<!DOCTYPE>`
// and CDATA are understood; the five predefined entities and numeric references are decoded.
//
// Honest limits: namespaces are kept in the element name as written (a POM names its elements
// without a prefix), custom entities are left as written. The reader never throws: malformed
// input returns the elements it could read (unclosed elements are closed at the end of the
// input, a stray end tag closes the nearest open element of that name or is ignored).

export type XmlElement = {
  name: string;
  attributes: Record<string, string>;
  // Direct text and CDATA of the element, decoded, not trimmed.
  text: string;
  children: XmlElement[];
  // 1-based line of the start tag.
  line: number;
};

export type XmlRead = {
  // The document element (a synthetic `#document` element when the input has none).
  root: XmlElement;
  // False when the input was malformed (unclosed or stray tags, unterminated constructs).
  wellFormed: boolean;
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/gu, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    }
    return ENTITIES[body] ?? whole;
  });
}

export function readXml(source: string): XmlRead {
  const root: XmlElement = { name: "#document", attributes: {}, text: "", children: [], line: 1 };
  const stack: XmlElement[] = [root];
  let wellFormed = true;
  let line = 1;
  let pos = 0;
  const length = source.length;

  // Advance `pos` to `to`, counting the newlines passed.
  const advance = (to: number): void => {
    for (let index = pos; index < to; index += 1) if (source.charCodeAt(index) === 10) line += 1;
    pos = to;
  };
  const top = (): XmlElement => stack[stack.length - 1]!;

  while (pos < length) {
    const lt = source.indexOf("<", pos);
    if (lt === -1) {
      top().text += decodeXmlEntities(source.slice(pos));
      advance(length);
      break;
    }
    if (lt > pos) {
      top().text += decodeXmlEntities(source.slice(pos, lt));
      advance(lt);
    }
    if (source.startsWith("<!--", pos)) {
      const end = source.indexOf("-->", pos + 4);
      if (end === -1) {
        wellFormed = false;
        advance(length);
      } else advance(end + 3);
      continue;
    }
    if (source.startsWith("<![CDATA[", pos)) {
      const end = source.indexOf("]]>", pos + 9);
      if (end === -1) {
        wellFormed = false;
        top().text += source.slice(pos + 9);
        advance(length);
      } else {
        top().text += source.slice(pos + 9, end);
        advance(end + 3);
      }
      continue;
    }
    if (source.startsWith("<?", pos) || source.startsWith("<!", pos)) {
      // Prolog, processing instruction or DOCTYPE (with an optional internal subset in brackets).
      let end = pos + 2;
      let depth = 0;
      while (end < length) {
        const ch = source[end];
        if (ch === "[") depth += 1;
        else if (ch === "]") depth -= 1;
        else if (ch === ">" && depth <= 0) break;
        end += 1;
      }
      if (end >= length) {
        wellFormed = false;
        advance(length);
      } else advance(end + 1);
      continue;
    }
    if (source.startsWith("</", pos)) {
      const end = source.indexOf(">", pos);
      const name = source.slice(pos + 2, end === -1 ? length : end).trim();
      if (end === -1) wellFormed = false;
      let index = stack.length - 1;
      while (index > 0 && stack[index]!.name !== name) index -= 1;
      if (index === 0) wellFormed = false;
      else {
        if (index !== stack.length - 1) wellFormed = false;
        stack.length = index;
      }
      advance(end === -1 ? length : end + 1);
      continue;
    }
    // A start tag: scan to its `>` outside of quoted attribute values.
    let end = pos + 1;
    let quote = "";
    while (end < length) {
      const ch = source[end]!;
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
      end += 1;
    }
    if (end >= length) {
      wellFormed = false;
      advance(length);
      break;
    }
    let inner = source.slice(pos + 1, end);
    const selfClosing = inner.endsWith("/");
    if (selfClosing) inner = inner.slice(0, -1);
    const nameMatch = /^[^\s/>]+/u.exec(inner);
    if (!nameMatch) {
      // A bare `<` that starts no element: keep it as text.
      wellFormed = false;
      top().text += "<";
      advance(pos + 1);
      continue;
    }
    const element: XmlElement = {
      name: nameMatch[0],
      attributes: readAttributes(inner.slice(nameMatch[0].length)),
      text: "",
      children: [],
      line,
    };
    top().children.push(element);
    if (!selfClosing) stack.push(element);
    advance(end + 1);
  }

  if (stack.length > 1) wellFormed = false;
  // A document with one top-level element reads as that element.
  const only = root.children.length === 1 ? root.children[0]! : root;
  return { root: only, wellFormed };
}

function readAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) attributes[match[1]!] = decodeXmlEntities(match[2] ?? match[3] ?? "");
  return attributes;
}

export function childElements(element: XmlElement | null | undefined, name: string): XmlElement[] {
  return element ? element.children.filter((child) => child.name === name) : [];
}

export function childElement(element: XmlElement | null | undefined, name: string): XmlElement | null {
  return childElements(element, name)[0] ?? null;
}

// Trimmed text of the first child with that name, null when there is none or it is empty.
export function childText(element: XmlElement | null | undefined, name: string): string | null {
  const child = childElement(element, name);
  if (!child) return null;
  const text = child.text.trim();
  return text === "" ? null : text;
}

// Follow a chain of child names (`path(root, "build", "plugins")`).
export function descend(element: XmlElement | null | undefined, ...names: string[]): XmlElement | null {
  let current: XmlElement | null = element ?? null;
  for (const name of names) {
    current = childElement(current, name);
    if (!current) return null;
  }
  return current;
}
