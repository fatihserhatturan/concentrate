import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { CppParsePlugin } from "../../languages/cpp/parser.js";
import { findInvocations, ownerOf, readCppSource } from "./scan.js";

// Qt signals and slots. A `connect(sender, &A::signal, receiver, &B::slot)`
// (also `QObject::connect`, `connect(sender, &A::signal, &B::staticSlot)`) and
// the string form `connect(a, SIGNAL(done(int)), b, SLOT(onDone(int)))` link
// the signal to the slot (SIGNAL_CONNECTS_TO, with the line and file of the
// connect call), and the connect call resolves to the slot (CALL_RESOLVES_TO,
// `via: "qt"`) so callers and impact reach it. A class not written as
// `A::` in the string form is the enclosing class when the object is `this`
// or left out; a signal or slot is found in the class or its bases. Signals
// of Qt's own classes (`&QPushButton::clicked`) are not in the scan, and a
// lambda slot has no name to link.

type Endpoint = { className: string | null; name: string };
type Connection = { call: string | null; owner: string; line: number; signal: Endpoint; slot: Endpoint; style: "pointer" | "string"; file: string };

export const cppQtPlugin: CppParsePlugin = ({ fileNodeId, relativePath, source: written, nodes, relationships }) => {
  if (!/\bconnect\s*\(/u.test(written) || !/\bQObject\b|\bSIGNAL\b|\bQ_OBJECT\b|\bQt\b|#include\s*<Q/u.test(written)) return;
  const source = readCppSource(written);
  const owner = ownerOf(nodes, fileNodeId);
  const connections: Connection[] = [];
  const calls = nodes.filter((node) => node.label === "Call" && node.properties.callee === "connect");
  for (const call of findInvocations(source, "connect")) {
    if (call.receiver !== null || (call.qualifier !== null && !/(?:^|::)QObject$/u.test(call.qualifier)) || call.args.length < 3) continue;
    const ownerId = owner(call.line);
    const enclosing = nodes.find((node) => node.id === ownerId)?.properties.className;
    const enclosingClass = typeof enclosing === "string" ? enclosing : null;
    const pointer = (argument: string | undefined): Endpoint | null => {
      const match = argument === undefined ? null : /^&\s*((?:\w+\s*::\s*)+)(\w+)$/u.exec(argument.trim());
      if (!match) return null;
      return { className: match[1]!.replace(/\s+/gu, "").replace(/::$/u, "").split("::").at(-1)!, name: match[2]! };
    };
    const text = (argument: string | undefined, macro: "SIGNAL" | "SLOT"): string | null => {
      const match = argument === undefined ? null : new RegExp(String.raw`^(?:QT_)?${macro}\s*\(\s*(\w+)\s*\(`, "u").exec(argument.trim());
      return match ? match[1]! : null;
    };
    const isThis = (argument: string | undefined) => argument === undefined || /^this$/u.test(argument.trim());
    let signal = pointer(call.args[1]);
    let slot = call.args.length >= 4 ? pointer(call.args[3]) : pointer(call.args[2]);
    let style: Connection["style"] = "pointer";
    if (!signal) {
      const signalName = text(call.args[1], "SIGNAL");
      const slotName = text(call.args[3] ?? call.args[2], "SLOT");
      if (signalName === null || slotName === null) continue;
      signal = { className: isThis(call.args[0]) ? enclosingClass : null, name: signalName };
      slot = { className: isThis(call.args[2]) || call.args.length < 4 ? enclosingClass : null, name: slotName };
      if (call.args.length >= 4 && !isThis(call.args[2])) slot.className = null;
      style = "string";
    }
    if (!signal || !slot) continue;
    let callNode = calls.find((node) => node.properties.line === call.line && Number(node.properties.columnNumber) <= call.column);
    if (!callNode && ownerId !== fileNodeId) {
      // The grammar left the statement out (macros in the arguments): the call is made here.
      const expression = `${call.prefix}connect`;
      callNode = {
        id: `${ownerId}:call:${call.line}:${call.column}:${expression}`,
        label: "Call",
        properties: { name: expression, expression, callee: "connect", receiver: null, line: call.line, columnNumber: call.column, argCount: call.args.length, ...(call.qualifier ? { qualifier: call.qualifier } : {}) },
      };
      nodes.push(callNode);
      relationships.push({ from: ownerId, to: callNode.id, type: "CALLS", properties: {} });
    }
    connections.push({ call: callNode?.id ?? null, owner: ownerId, line: call.line, signal, slot, style, file: relativePath });
  }
  const file = nodes.find((node) => node.id === fileNodeId);
  if (file && connections.length > 0) file.properties.cppQtConnects = JSON.stringify(connections);
};

export const cppQtContributor: ISemanticContributor = {
  contribute(graph) {
    const files = graph.nodes.filter((node) => node.label === "File" && typeof node.properties.cppQtConnects === "string");
    if (files.length === 0) return;
    const methods = new Map<string, GraphNode[]>();
    const bases = new Map<string, string[]>();
    for (const node of graph.nodes) {
      if (node.label === "Function" && typeof node.properties.className === "string" && node.properties.kind !== "constructor" && node.properties.kind !== "destructor") {
        const key = `${node.properties.className}\0${node.properties.name}`;
        methods.set(key, [...methods.get(key) ?? [], node]);
      } else if (node.label === "Class" && typeof node.properties.bases === "string") {
        const names = (JSON.parse(node.properties.bases) as Array<{ name: string }>).map((base) => base.name.split("::").at(-1)!);
        bases.set(String(node.properties.name), [...bases.get(String(node.properties.name)) ?? [], ...names]);
      }
    }
    // A class the string form does not name: the only class with the member.
    const classesWith = new Map<string, Set<string>>();
    for (const node of [...methods.values()].flat()) {
      const set = classesWith.get(String(node.properties.name)) ?? new Set<string>();
      set.add(String(node.properties.className));
      classesWith.set(String(node.properties.name), set);
    }
    // Classes of one name in several directories (examples): the one nearest the connect call.
    const nearness = (node: GraphNode, from: string) => {
      const file = node.id.split(":function:")[0]!.replace(/^file:/u, "");
      if (file === from) return 0;
      if (file.replace(/\.[^./]+$/u, "") === from.replace(/\.[^./]+$/u, "")) return 1;
      const directory = (value: string) => value.split("/").slice(0, -1);
      const left = directory(file);
      const right = directory(from);
      let shared = 0;
      while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared += 1;
      return 2 + (Math.max(left.length, right.length) - shared);
    };
    let from = "";
    const find = (endpoint: Endpoint, preferDefinition: boolean, depth = 0): GraphNode | null => {
      if (endpoint.className === null) {
        const only = classesWith.get(endpoint.name);
        return only?.size === 1 ? find({ className: [...only][0]!, name: endpoint.name }, preferDefinition, depth) : null;
      }
      const found = methods.get(`${endpoint.className}\0${endpoint.name}`);
      if (found && found.length > 0) {
        const nearest = Math.min(...found.map((node) => nearness(node, from)));
        const near = found.filter((node) => nearness(node, from) === nearest);
        return (preferDefinition ? near.find((node) => node.properties.isDeclaration !== true) : undefined) ?? near.find((node) => node.properties.isDeclaration === true) ?? near[0]!;
      }
      if (depth >= 4) return null;
      for (const base of bases.get(endpoint.className) ?? []) {
        const inherited = find({ className: base, name: endpoint.name }, preferDefinition, depth + 1);
        if (inherited) return inherited;
      }
      return null;
    };

    const relationships: GraphRelationship[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      const connections = JSON.parse(String(file.properties.cppQtConnects)) as Connection[];
      delete file.properties.cppQtConnects;
      for (const connection of connections) {
        from = connection.file.split("\\").join("/");
        const slot = find(connection.slot, true);
        if (!slot) continue;
        if (connection.call) relationships.push({ from: connection.call, to: slot.id, type: "CALL_RESOLVES_TO", properties: { via: "qt" } });
        const signal = find(connection.signal, false);
        if (!signal) continue;
        const key = `${signal.id}\0${slot.id}\0${connection.file}\0${connection.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        relationships.push({ from: signal.id, to: slot.id, type: "SIGNAL_CONNECTS_TO", properties: { line: connection.line, file: connection.file, style: connection.style } });
      }
    }
    graph.addRelationships(relationships);
  },
};
