// Syntax highlighting, loaded on first use so the first screen stays small. Only the
// languages Concentrate reads are registered.
const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rs: "rust", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  json: "json", css: "css", scss: "css", yml: "yaml", yaml: "yaml", sh: "bash", bash: "bash", sql: "sql",
  html: "xml", htm: "xml", xml: "xml", vue: "xml", svelte: "xml", astro: "xml", md: "markdown", proto: "protobuf", toml: "ini",
};

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let loading: Promise<typeof import("highlight.js/lib/core").default> | null = null;

function load() {
  loading ??= (async () => {
    const [core, typescript, javascript, python, go, rust, c, cpp, json, css, yaml, bash, sql, xml, markdown, protobuf, ini] = await Promise.all([
      import("highlight.js/lib/core"), import("highlight.js/lib/languages/typescript"), import("highlight.js/lib/languages/javascript"),
      import("highlight.js/lib/languages/python"), import("highlight.js/lib/languages/go"), import("highlight.js/lib/languages/rust"),
      import("highlight.js/lib/languages/c"), import("highlight.js/lib/languages/cpp"), import("highlight.js/lib/languages/json"),
      import("highlight.js/lib/languages/css"), import("highlight.js/lib/languages/yaml"), import("highlight.js/lib/languages/bash"),
      import("highlight.js/lib/languages/sql"), import("highlight.js/lib/languages/xml"), import("highlight.js/lib/languages/markdown"),
      import("highlight.js/lib/languages/protobuf"), import("highlight.js/lib/languages/ini"),
    ]);
    const hljs = core.default;
    for (const [name, definition] of Object.entries({ typescript, javascript, python, go, rust, c, cpp, json, css, yaml, bash, sql, xml, markdown, protobuf, ini })) {
      hljs.registerLanguage(name, definition.default);
    }
    return hljs;
  })();
  return loading;
}

/** HTML for a piece of source; plain escaped text when the language is unknown or loading fails. */
export async function highlightSource(code: string, file: string | null): Promise<string> {
  const extension = file?.split(".").pop()?.toLowerCase() ?? "";
  const language = LANGUAGES[extension] ?? (file && /(^|\/)(Makefile|Dockerfile)$/.test(file) ? "bash" : undefined);
  if (!language) return escapeHtml(code);
  try {
    return (await load()).highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}
