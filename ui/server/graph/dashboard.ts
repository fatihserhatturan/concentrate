import { loadIndex } from "./index.js";
import { fileDegrees } from "./entities.js";

const KIND_LABELS: Array<[string, string]> = [
  ["File", "Files"], ["Function", "Functions"], ["Class", "Classes"], ["Interface", "Interfaces"], ["Route", "Routes"],
  ["EntryPoint", "Entrypoints"], ["Table", "Tables"], ["DataModel", "Data models"], ["Component", "Components"], ["Page", "Pages"],
  ["Store", "Stores"], ["EnvVar", "Env variables"], ["Service", "Services"], ["Rpc", "RPCs"],
];
const KIND_VIEWS: Record<string, string> = {
  File: "files", Route: "routes", EntryPoint: "entrypoints", Table: "tables", DataModel: "tables", Component: "components", Page: "components", EnvVar: "env",
};

export async function dashboard(projectPath: string) {
  const index = await loadIndex(projectPath);
  const counts = new Map<string, number>();
  const languages = new Map<string, number>();
  let tests = 0;
  const files = [];
  for (const node of index.nodes.values()) {
    counts.set(node.label, (counts.get(node.label) ?? 0) + 1);
    if (node.label !== "File") continue;
    files.push(node);
    const language = typeof node.props.language === "string" ? node.props.language : "other";
    languages.set(language, (languages.get(language) ?? 0) + 1);
    if (node.props.isTest === true) tests += 1;
  }
  const { out, inn } = fileDegrees(index);
  const topFiles = files
    .map((f) => ({ id: f.id, path: String(f.props.relativePath ?? f.id), language: String(f.props.language ?? "other"), usedBy: inn.get(f.id) ?? 0, uses: out.get(f.id) ?? 0 }))
    .map((f) => ({ ...f, links: f.usedBy + f.uses }))
    .filter((f) => f.links > 0)
    .sort((a, b) => b.links - a.links || a.path.localeCompare(b.path))
    .slice(0, 10);
  const packages = [...index.nodes.values()]
    .filter((n) => n.label === "Package")
    .map((n) => ({ name: String(n.props.name ?? n.id), path: String(n.props.relativePath ?? ""), manager: typeof n.props.manager === "string" ? n.props.manager : null, files: [...index.packageOf.values()].filter((name) => name === n.props.name).length }))
    .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
  return {
    repo: { name: String([...index.nodes.values()].find((n) => n.label === "Repo")?.props.name ?? ""), path: index.rootPath },
    schemaVersion: index.schemaVersion,
    files: { total: files.length, tests },
    languages: [...languages].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    packages,
    kinds: KIND_LABELS.filter(([label]) => (counts.get(label) ?? 0) > 0).map(([label, title]) => ({ label: title, count: counts.get(label)!, view: KIND_VIEWS[label] ?? null })),
    topFiles,
  };
}
