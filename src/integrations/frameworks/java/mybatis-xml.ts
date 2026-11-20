import { decodeXmlEntities } from "../../languages/java/build/xml.js";

// MyBatis mapper XML: the statements (`<select|insert|update|delete id>`) of a `<mapper namespace>` as SQL
// text. The vendored build XML reader (`readXml`) keeps an element's text apart from its children's, so
// the order of mixed content is lost; SQL needs the order (`<where>` and `<if>` sit inside the statement), so
// this reads the markup itself with the same entity decoding.
//
//   - comments, the prolog, `<!DOCTYPE …>` (with an internal subset) and processing instructions are dropped;
//     CDATA is text as written (not entity-decoded);
//   - dynamic tags (`<if>`, `<where>`, `<foreach>`, `<choose>`, `<when>`, `<otherwise>`, `<trim>`, `<set>`,
//     `<selectKey>`, any unknown tag) are removed and the text they hold is kept; `<bind>` is dropped;
//   - `<include refid="x"/>` is replaced by the text of `<sql id="x">` of the same file (or `ns.x` of
//     another mapper file); `<property>` children and `${…}` fragment properties are not substituted; a
//     cycle or more than eight levels of includes stops, leaving the include out;
//   - `#{…}` becomes `?`, and `${…}` becomes `?` as well (a dynamic table or column is unknown).
// Not read: `<resultMap>`, `<cache>`, `<parameterMap>` (they hold no SQL).

type XmlText = { text: string };
type XmlTag = { name: string; attributes: Record<string, string>; children: Array<XmlText | XmlTag>; line: number };

export type MapperStatement = {
  id: string;
  kind: "select" | "insert" | "update" | "delete";
  /** The statement's SQL with `#{}` / `${}` replaced by `?`, whitespace collapsed. */
  sql: string;
  /** 1-based line of the statement's start tag. */
  line: number;
};

export type MapperFile = {
  namespace: string;
  statements: MapperStatement[];
  /** `<sql id>` fragments of the file by id, as raw tags. */
  fragments: Map<string, XmlTag>;
  statementTags: Array<{ tag: XmlTag; kind: MapperStatement["kind"] }>;
};

const STATEMENTS = new Set(["select", "insert", "update", "delete"]);

function parse(source: string): XmlTag {
  const root: XmlTag = { name: "#document", attributes: {}, children: [], line: 1 };
  const stack: XmlTag[] = [root];
  let line = 1;
  let pos = 0;
  const advance = (to: number): void => {
    for (let index = pos; index < to; index += 1) if (source.charCodeAt(index) === 10) line += 1;
    pos = to;
  };
  const addText = (text: string, raw: boolean): void => {
    if (text === "") return;
    stack[stack.length - 1]!.children.push({ text: raw ? text : decodeXmlEntities(text) });
  };
  while (pos < source.length) {
    const lt = source.indexOf("<", pos);
    if (lt === -1) {
      addText(source.slice(pos), false);
      break;
    }
    addText(source.slice(pos, lt), false);
    advance(lt);
    if (source.startsWith("<!--", pos)) {
      const end = source.indexOf("-->", pos + 4);
      advance(end === -1 ? source.length : end + 3);
    } else if (source.startsWith("<![CDATA[", pos)) {
      const end = source.indexOf("]]>", pos + 9);
      addText(source.slice(pos + 9, end === -1 ? source.length : end), true);
      advance(end === -1 ? source.length : end + 3);
    } else if (source.startsWith("<?", pos)) {
      const end = source.indexOf("?>", pos + 2);
      advance(end === -1 ? source.length : end + 2);
    } else if (source.startsWith("<!", pos)) {
      // `<!DOCTYPE mapper PUBLIC "…" "…">`, with an optional `[ … ]` internal subset.
      let depth = 0;
      let index = pos + 2;
      for (; index < source.length; index += 1) {
        const char = source[index]!;
        if (char === "[") depth += 1;
        else if (char === "]") depth -= 1;
        else if (char === ">" && depth <= 0) break;
      }
      advance(Math.min(index + 1, source.length));
    } else if (source.startsWith("</", pos)) {
      const end = source.indexOf(">", pos);
      const name = source.slice(pos + 2, end === -1 ? source.length : end).trim();
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index]!.name === name) {
          stack.length = index;
          break;
        }
      }
      advance(end === -1 ? source.length : end + 1);
    } else {
      // `a < b`, `a <= b` in SQL (a mapper should write `&lt;`, but not every one does): text.
      if (/^[\s=\d?#$]/u.test(source[pos + 1] ?? " ")) {
        addText("<", false);
        advance(pos + 1);
        continue;
      }
      // A start tag: quotes may hold `>` (`test="a > b"`).
      let index = pos + 1;
      let quote: string | null = null;
      for (; index < source.length; index += 1) {
        const char = source[index]!;
        if (quote) {
          if (char === quote) quote = null;
        } else if (char === '"' || char === "'") quote = char;
        else if (char === ">") break;
      }
      const inner = source.slice(pos + 1, index);
      const selfClosing = inner.endsWith("/");
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const nameMatch = /^\s*([^\s/>]+)/u.exec(body);
      if (!nameMatch) {
        addText("<", false);
        advance(pos + 1);
        continue;
      }
      const attributes: Record<string, string> = {};
      for (const match of body.slice(nameMatch[0].length).matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) attributes[match[1]!] = decodeXmlEntities(match[2] ?? match[3] ?? "");
      const tag: XmlTag = { name: nameMatch[1]!, attributes, children: [], line };
      stack[stack.length - 1]!.children.push(tag);
      if (!selfClosing) stack.push(tag);
      advance(Math.min(index + 1, source.length));
    }
  }
  return root;
}

const tagsOf = (tag: XmlTag): XmlTag[] => tag.children.filter((child): child is XmlTag => "name" in child);

/** The mapper of a MyBatis mapper XML file; null when the file has no `<mapper namespace="…">` root. */
export function readMapperFile(source: string): MapperFile | null {
  if (!source.includes("<mapper")) return null;
  const root = tagsOf(parse(source)).find((tag) => tag.name === "mapper");
  const namespace = root?.attributes.namespace?.trim();
  if (!root || !namespace) return null;
  const fragments = new Map<string, XmlTag>();
  const statementTags: MapperFile["statementTags"] = [];
  for (const child of tagsOf(root)) {
    if (child.name === "sql" && child.attributes.id) fragments.set(child.attributes.id, child);
    else if (STATEMENTS.has(child.name) && child.attributes.id) statementTags.push({ tag: child, kind: child.name as MapperStatement["kind"] });
  }
  return { namespace, statements: [], fragments, statementTags };
}

const MAX_INCLUDE_DEPTH = 8;

function render(tag: XmlTag, own: MapperFile, all: ReadonlyMap<string, XmlTag>, depth: number, seen: ReadonlySet<XmlTag>): string {
  let text = "";
  for (const child of tag.children) {
    if ("text" in child) {
      text += child.text;
    } else if (child.name === "include") {
      const refid = (child.attributes.refid ?? "").replace(/\$\{[^}]*\}/gu, "");
      const fragment = own.fragments.get(refid) ?? all.get(refid);
      if (fragment && depth < MAX_INCLUDE_DEPTH && !seen.has(fragment)) text += ` ${render(fragment, own, all, depth + 1, new Set([...seen, fragment]))} `;
    } else if (child.name !== "bind" && child.name !== "property") {
      text += ` ${render(child, own, all, depth, seen)} `;
    }
  }
  return text;
}

const collapse = (text: string): string => text.replace(/#\{[^}]*\}|\$\{[^}]*\}/gu, "?").replace(/\s+/gu, " ").trim();

/**
 * The statements of every mapper file, includes resolved (`<include refid="cols"/>` against the same file's
 * `<sql>` and, qualified as `namespace.id`, against the other files').
 */
export function mapperStatements(files: readonly MapperFile[]): MapperFile[] {
  const all = new Map<string, XmlTag>();
  for (const file of files) for (const [id, tag] of file.fragments) all.set(`${file.namespace}.${id}`, tag);
  return files.map((file) => ({
    ...file,
    statements: file.statementTags.map(({ tag, kind }) => ({ id: tag.attributes.id!, kind, sql: collapse(render(tag, file, all, 0, new Set())), line: tag.line })),
  }));
}
