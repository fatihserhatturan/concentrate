import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { CppParsePlugin } from "../../languages/cpp/parser.js";
import { findInvocations, ownerOf, readCppSource, stringConstants, stringValue } from "./scan.js";

// C and C++ env reads, as USES_ENV from the function that reads (and the file)
// to an EnvVar:
//   - `getenv("X")`, `std::getenv`, `::getenv`, `secure_getenv`, `_wgetenv`,
//     Qt's `qgetenv("X")` / `qEnvironmentVariable("X")` / `qEnvironmentVariableIsSet`,
//     `getenv_s(&n, buf, size, "X")`, `_dupenv_s(&buf, &n, "X")` and Windows'
//     `GetEnvironmentVariable("X", …)`;
//   - CLI11's `->envname("X")`;
// the name a literal, a `#define` / `const` of the file, or a constant another
// file declares (resolved once every file is parsed, when the name is
// declared once with one value). The variables `.env` files declare come from
// the language-neutral env files contributor.

const NAME = /^[A-Za-z_]\w*$/u;
// Where the variable name is among the arguments.
const READERS: Array<{ names: string; index: number }> = [
  { names: "getenv|secure_getenv|_wgetenv|qgetenv|qEnvironmentVariable|qEnvironmentVariableIsSet|qEnvironmentVariableIntValue|qEnvironmentVariableIsEmpty", index: 0 },
  { names: "GetEnvironmentVariable[AW]?|GetEnvironmentVariableEx", index: 0 },
  { names: "getenv_s", index: 3 },
  { names: "_dupenv_s|_wdupenv_s", index: 2 },
  { names: "envname", index: 0 },
  // A namespaced wrapper of getenv (googletest's `internal::posix::GetEnv`, gRPC's `grpc_core::GetEnv`).
  { names: "GetEnv", index: 0 },
];
type Pending = { owner: string; line: number; access: string; constant: string };

export const cppEnvConfigPlugin: CppParsePlugin = ({ fileNodeId, source: written, nodes, relationships }) => {
  if (!/\b(?:getenv|secure_getenv|_wgetenv|qgetenv|qEnvironmentVariable\w*|GetEnvironmentVariable\w*|getenv_s|_w?dupenv_s|envname|GetEnv)\b|#\s*define\s+\w+\s+"[A-Z][A-Z0-9_]*"|"[A-Z][A-Z0-9_]*"\s*;/u.test(written)) return;
  const source = readCppSource(written);
  const constants = stringConstants(source);
  const owner = ownerOf(nodes, fileNodeId);
  const reads: Array<{ owner: string; name: string; line: number; access: string }> = [];
  const pending: Pending[] = [];

  for (const { names, index } of READERS) {
    if (!written.includes(names.split("|")[0]!.replace(/\[.*$/u, ""))) continue;
    for (const call of findInvocations(source, names)) {
      // `getenv` is a function, `envname` a CLI11 method; a method named like a reader is not.
      if (call.name === "envname" ? call.receiver === null : call.name === "GetEnv" ? call.receiver !== null : call.receiver !== null || (call.qualifier !== null && !/^(?:std|)$/u.test(call.qualifier.replace(/^::/u, "")))) continue;
      const argument = call.args[index];
      if (argument === undefined) continue;
      const value = stringValue(argument, constants);
      const access = call.name.replace(/[AW]$/u, "");
      if (value !== null) {
        if (NAME.test(value)) reads.push({ owner: owner(call.line), name: value, line: call.line, access });
      } else if (/^(?:\w+::)*[A-Z][A-Z0-9_]*$/u.test(argument.trim())) {
        pending.push({ owner: owner(call.line), line: call.line, access, constant: argument.trim().replace(/^(?:\w+::)*/u, "") });
      }
    }
  }

  const file = nodes.find((node) => node.id === fileNodeId);
  if (file && pending.length > 0) file.properties.cppEnvPending = JSON.stringify(pending);
  // Only constants that look like env names are worth keeping for other files.
  const named = [...constants].filter(([, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value));
  if (file && named.length > 0) file.properties.cppEnvConsts = JSON.stringify(named);

  const seen = new Set<string>();
  const added = new Set<string>();
  for (const read of reads) {
    for (const from of read.owner === fileNodeId ? [fileNodeId] : [read.owner, fileNodeId]) {
      const key = `${from}\0${read.name}\0${read.line}\0${read.access}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!added.has(read.name)) {
        added.add(read.name);
        nodes.push(envVarNode(read.name));
      }
      relationships.push({ from, to: `env:${read.name}`, type: "USES_ENV", properties: { line: read.line, access: read.access } });
    }
  }
};

export const cppEnvConfigContributor: ISemanticContributor = {
  contribute(graph) {
    const files = graph.nodes.filter((node) => node.label === "File" && (typeof node.properties.cppEnvPending === "string" || typeof node.properties.cppEnvConsts === "string"));
    if (files.length === 0) return;
    const values = new Map<string, Set<string>>();
    const pending: Array<Pending & { file: string }> = [];
    for (const file of files) {
      if (typeof file.properties.cppEnvConsts === "string") {
        for (const [name, value] of JSON.parse(file.properties.cppEnvConsts) as Array<[string, string]>) values.set(name, (values.get(name) ?? new Set()).add(value));
      }
      if (typeof file.properties.cppEnvPending === "string") {
        for (const entry of JSON.parse(file.properties.cppEnvPending) as Pending[]) pending.push({ ...entry, file: file.id });
      }
      delete file.properties.cppEnvConsts;
      delete file.properties.cppEnvPending;
    }
    const known = new Set(graph.nodes.filter((node) => node.label === "EnvVar").map((node) => node.id));
    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    const seen = new Set<string>();
    for (const entry of pending) {
      const candidates = values.get(entry.constant);
      if (!candidates || candidates.size !== 1) continue;
      const name = [...candidates][0]!;
      const id = `env:${name}`;
      if (!known.has(id)) {
        known.add(id);
        nodes.push(envVarNode(name));
      }
      for (const from of entry.owner === entry.file ? [entry.owner] : [entry.owner, entry.file]) {
        const key = `${from}\0${name}\0${entry.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        relationships.push({ from, to: id, type: "USES_ENV", properties: { line: entry.line, access: entry.access } });
      }
    }
    graph.addNodes(nodes);
    graph.addRelationships(relationships);
  },
};

function envVarNode(name: string): GraphNode {
  return { id: `env:${name}`, label: "EnvVar", properties: { name } };
}
