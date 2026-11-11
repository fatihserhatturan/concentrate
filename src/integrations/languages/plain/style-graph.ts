import type { GraphNode, ParsedSourceFile } from "../../../core/graph/model.js";
import { readStyles, type StyleLanguage, type StyleReading } from "./styles.js";

// Rules per file that get a node; a bundled sheet can hold tens of thousands.
const MAX_RULE_NODES = 5000;

// A CSS Modules file: its class names are local to the file.
export function isStyleModule(relativePath: string): boolean {
  return /\.module\.(?:css|scss|sass|less)$/iu.test(relativePath);
}

export function styleNodeId(fileNodeId: string, kind: string, name: string): string {
  return `${fileNodeId}:style:${kind}:${name}`;
}

// The graph of a style file: a `Style` node per class, id, custom property
// and rule (DECLARES_STYLE from the file; SELECTS_STYLE from a rule to its
// classes and ids), and an `Import` per `@import`, `@use`, `@forward`,
// `url()` and `composes … from`. `var(--x)` uses stay on the file until the
// styles contributor links them to definitions anywhere in the project.
export function styleGraph(
  fileNodeId: string,
  relativePath: string,
  language: StyleLanguage,
  source: string,
  parsed: ParsedSourceFile,
): void {
  addStyleReading(fileNodeId, relativePath, readStyles(source, language), parsed, 0);
}

// `lineOffset`: lines before the style text, for a `<style>` block of a component.
export function addStyleReading(
  fileNodeId: string,
  relativePath: string,
  reading: StyleReading,
  parsed: ParsedSourceFile,
  lineOffset: number,
): void {
  const moduleFile = isStyleModule(relativePath);
  const declared = (node: GraphNode) => {
    parsed.nodes.push(node);
    parsed.relationships.push({ from: fileNodeId, to: node.id, type: "DECLARES_STYLE", properties: {} });
  };
  const ids = new Map<string, string>();
  for (const entry of reading.classes.values()) {
    const id = styleNodeId(fileNodeId, "class", entry.name);
    ids.set(`.${entry.name}`, id);
    declared({
      id,
      label: "Style",
      properties: { name: entry.name, kind: "class", line: entry.line + lineOffset, scope: entry.scope ?? (moduleFile ? "module" : null) },
    });
  }
  for (const entry of reading.ids.values()) {
    const id = styleNodeId(fileNodeId, "id", entry.name);
    ids.set(`#${entry.name}`, id);
    declared({ id, label: "Style", properties: { name: entry.name, kind: "id", line: entry.line + lineOffset } });
  }
  for (const entry of reading.definitions.values()) {
    declared({ id: styleNodeId(fileNodeId, "custom-property", entry.name), label: "Style", properties: { name: entry.name, kind: "custom-property", line: entry.line + lineOffset } });
  }

  const seen = new Map<number, number>();
  for (const rule of reading.rules.slice(0, MAX_RULE_NODES)) {
    const count = seen.get(rule.line) ?? 0;
    seen.set(rule.line, count + 1);
    const node: GraphNode = {
      id: `${fileNodeId}:style:rule:${rule.line + lineOffset}:${count}`,
      label: "Style",
      properties: {
        name: rule.selector,
        kind: "rule",
        selector: rule.selector,
        line: rule.line + lineOffset,
        endLine: rule.endLine + lineOffset,
        atRule: rule.atRule,
      },
    };
    declared(node);
    for (const target of [...rule.classes.map((name) => `.${name}`), ...rule.ids.map((name) => `#${name}`)]) {
      const targetId = ids.get(target);
      if (targetId) parsed.relationships.push({ from: node.id, to: targetId, type: "SELECTS_STYLE", properties: {} });
    }
  }

  for (const entry of reading.imports) {
    const id = `${fileNodeId}:import:${entry.line + lineOffset}:${entry.source}`;
    if (parsed.nodes.some((node) => node.id === id)) continue;
    parsed.nodes.push({
      id,
      label: "Import",
      properties: {
        source: entry.source,
        specifier: entry.text,
        line: entry.line + lineOffset,
        isReExport: false,
        isWildcard: false,
        isDynamic: false,
        isCjs: false,
        isTypeOnly: false,
        bindings: null,
        alias: entry.alias,
      },
    });
    parsed.relationships.push({ from: fileNodeId, to: id, type: "IMPORTS", properties: {} });
  }

  if (reading.varUses.length > 0) {
    const file = parsed.nodes.find((node) => node.id === fileNodeId);
    if (file) {
      const previous = typeof file.properties.styleVarUses === "string" ? (JSON.parse(file.properties.styleVarUses) as unknown[]) : [];
      file.properties.styleVarUses = JSON.stringify([...previous, ...reading.varUses.map((use) => ({ name: use.name, line: use.line + lineOffset }))]);
    }
  }
}
