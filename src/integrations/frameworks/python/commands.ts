import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { PythonContext } from "./context.js";

// Python entrypoints besides `__main__` and console scripts:
//
// - Celery: `@shared_task` and `@app.task` (`app = Celery(..)`) functions are
//   EntryPoints (kind `queue`, library `celery`, trigger the task name: the
//   `name=` argument, else `module.function`). `task.delay(..)`,
//   `.apply_async`, `.s`, `.si`, `.signature` and `app.send_task("name")`
//   resolve to the task (CALL_RESOLVES_TO via `celery`).
// - click: `@click.group()` / `@click.command()` functions and the commands
//   attached with `@group.command()` or `group.add_command(cmd)` are
//   EntryPoints (kind `cli`, library `click`, trigger the command path below
//   the root group, `db migrate`; the root group's trigger is its own name).
//   Names follow click: `-` for `_`, and `_command`/`_group` dropped.
// - typer: `app = typer.Typer()` with `@app.command()`, nested by
//   `app.add_typer(sub, name="users")`; `typer.run(main)`.
// - Flask CLI: `@app.cli.command()` (library `flask`).
// - Django management commands: `management/commands/<name>.py` with a
//   `Command` class whose `handle` is the entrypoint (kind `cli`, library `django`).

type CliNode = {
  id: string;
  functionId: string;
  fileId: string;
  name: string;
  kind: "command" | "group";
  library: "click" | "typer" | "flask";
  line: number;
  parent: CliNode | null;
  // The Typer app (key) a Typer command belongs to.
  typer: string | null;
};

type Typer = { key: string; fileId: string; name: string | null; parent: { typer: Typer; name: string | null } | null; line: number };

const CELERY_CALLS = new Set(["delay", "apply_async", "s", "si", "signature", "apply", "retry"]);
const CLICK_SUFFIX = /[_-](?:command|cmd|group|grp)$/u;

export function addPythonCommands(context: PythonContext, handlerIds: Set<string>): void {
  const { graph, index } = context;
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];
  const seenEntrypoints = new Set<string>();

  const entrypoint = (fileId: string, kind: string, trigger: string, library: string, line: number, handlerName: string, handlerId: string | null, receiverName: string | null = null) => {
    let id = `${fileId}:entrypoint:${line}:0:${kind}:${trigger}`;
    for (let n = 1; seenEntrypoints.has(id); n += 1) id = `${id.replace(/#\d+$/u, "")}#${n}`;
    seenEntrypoints.add(id);
    nodes.push({ id, label: "EntryPoint", properties: { kind, trigger, receiverName, library, line, handlerName } });
    relationships.push({ from: fileId, to: id, type: "DECLARES_ENTRYPOINT", properties: {} });
    if (handlerId) {
      relationships.push({ from: id, to: handlerId, type: "ENTRYPOINT_HANDLED_BY", properties: {} });
      handlerIds.add(handlerId);
    }
    return id;
  };

  const fileOf = (functionId: string) => context.fileOfFunction(functionId) ?? functionId.split(":function:")[0]!;
  const functions = [...context.nodeById.values()].filter((node) => node.label === "Function" && node.properties.className === null);
  const importsOf = new Map<string, Set<string>>();
  for (const rel of graph.relationships) {
    if (rel.type !== "IMPORTS") continue;
    const source = String(context.nodeById.get(rel.to)?.properties.source ?? "").split(".")[0]!;
    if (source === "click" || source === "typer" || source === "celery") {
      const set = importsOf.get(rel.from) ?? new Set<string>();
      set.add(source);
      importsOf.set(rel.from, set);
    }
  }

  // ---- Celery ---------------------------------------------------------------
  const celeryApps = new Set<string>();
  for (const [fileId, calls] of context.callsByFile) {
    for (const call of calls) if (call.assigned && call.callee.split(".").at(-1) === "Celery") celeryApps.add(`${fileId}|${call.scope ?? ""}|${call.assigned}`);
  }
  const isCeleryApp = (expression: string, fileId: string, scope: string | null): boolean => {
    if (celeryApps.has(`${fileId}|${scope ?? ""}|${expression}`) || celeryApps.has(`${fileId}|${""}|${expression}`)) return true;
    const variableId = index.lookupVariable(expression, fileId);
    const variable = variableId ? index.variablesById.get(variableId) : undefined;
    const file = variableId ? index.fileByVariableId.get(variableId) : undefined;
    return Boolean(variable && file && celeryApps.has(`${file}|${""}|${String(variable.properties.name)}`));
  };

  const tasks = new Map<string, { id: string; name: string }>();
  for (const fn of functions) {
    const decorators = context.decoratorsOf(fn.id);
    if (decorators.length === 0) continue;
    const fileId = fileOf(fn.id);
    const scope = context.factsByFile.get(fileId)?.nested[fn.id] ?? null;
    for (const decorator of decorators) {
      const last = decorator.name.split(".").at(-1)!;
      const receiver = decorator.name.includes(".") ? decorator.name.slice(0, decorator.name.lastIndexOf(".")) : null;
      const isTask = last === "shared_task"
        || ((last === "task" || last === "periodic_task") && receiver !== null && (receiver === "current_app" || receiver.endsWith(".current_app") || isCeleryApp(receiver, fileId, scope)));
      if (!isTask) continue;
      const module = context.resolver.moduleNameOf(context.relativeOf.get(fileId) ?? "");
      const explicit = context.literal(decorator.kwargs.name, fileId);
      const name = explicit ?? `${module ? `${module}.` : ""}${String(fn.properties.name)}`;
      tasks.set(fn.id, { id: fn.id, name });
      entrypoint(fileId, "queue", name, "celery", Number(fn.properties.line), String(fn.properties.name), fn.id, receiver);
      break;
    }
  }
  if (tasks.size > 0) {
    const taskByName = new Map([...tasks.values()].map((task) => [task.name, task.id]));
    const fileOfCall = new Map<string, string>();
    for (const rel of graph.relationships) {
      if (rel.type === "CALLS") fileOfCall.set(rel.to, fileOf(rel.from));
      else if (rel.type === "MODULE_CALLS") fileOfCall.set(rel.to, rel.from);
    }
    const resolved = new Set(graph.relationships.filter((rel) => rel.type === "CALL_RESOLVES_TO").map((rel) => `${rel.from}\0${rel.to}`));
    const link = (callId: string, taskId: string) => {
      const key = `${callId}\0${taskId}`;
      if (resolved.has(key)) return;
      resolved.add(key);
      relationships.push({ from: callId, to: taskId, type: "CALL_RESOLVES_TO", properties: { via: "celery" } });
    };
    for (const node of context.nodeById.values()) {
      if (node.label !== "Call" || typeof node.properties.receiver !== "string" || !CELERY_CALLS.has(String(node.properties.callee))) continue;
      const fileId = fileOfCall.get(node.id);
      if (!fileId) continue;
      const taskId = index.lookupFunction(String(node.properties.receiver), fileId);
      if (taskId && tasks.has(taskId)) link(node.id, taskId);
    }
    for (const [fileId, calls] of context.callsByFile) {
      for (const call of calls) {
        if (call.callee.split(".").at(-1) !== "send_task") continue;
        const name = context.literal(call.args[0] ?? call.kwargs.name, fileId);
        const taskId = name ? taskByName.get(name) : undefined;
        const callId = `${call.scope ?? fileId}:call:${call.line}:${call.column}:${call.callee}`;
        if (taskId && context.nodeById.has(callId)) link(callId, taskId);
      }
    }
  }

  // ---- click, typer, Flask CLI ---------------------------------------------
  const typers = new Map<string, Typer>();
  for (const [fileId, calls] of context.callsByFile) {
    for (const call of calls) {
      if (!call.assigned || call.callee.split(".").at(-1) !== "Typer" || !importsOf.get(fileId)?.has("typer")) continue;
      const key = `${fileId}|${call.scope ?? ""}|${call.assigned}`;
      typers.set(key, { key, fileId, name: context.literal(call.kwargs.name, fileId), parent: null, line: call.line });
    }
  }
  const resolveTyper = (expression: string, fileId: string, scope: string | null): Typer | null => {
    const local = typers.get(`${fileId}|${scope ?? ""}|${expression}`) ?? typers.get(`${fileId}|${""}|${expression}`);
    if (local) return local;
    const variableId = index.lookupVariable(expression, fileId);
    const variable = variableId ? index.variablesById.get(variableId) : undefined;
    const file = variableId ? index.fileByVariableId.get(variableId) : undefined;
    return variable && file ? typers.get(`${file}|${""}|${String(variable.properties.name)}`) ?? null : null;
  };
  for (const [fileId, calls] of context.callsByFile) {
    for (const call of calls) {
      if (call.callee.split(".").at(-1) !== "add_typer") continue;
      const parent = resolveTyper(call.callee.slice(0, call.callee.lastIndexOf(".")), fileId, call.scope);
      const child = call.args[0] ? resolveTyper(call.args[0], fileId, call.scope) : null;
      if (parent && child && parent !== child) child.parent = { typer: parent, name: context.literal(call.kwargs.name, fileId) ?? child.name };
    }
  }

  const cli = new Map<string, CliNode>();
  const clickName = (explicit: string | null, functionName: string, library: string): string => {
    if (explicit) return explicit;
    if (library === "typer") return functionName.replace(/_/gu, "-");
    return functionName.toLowerCase().replace(CLICK_SUFFIX, "").replace(/_/gu, "-");
  };
  for (const fn of functions) {
    const decorators = context.decoratorsOf(fn.id);
    if (decorators.length === 0) continue;
    const fileId = fileOf(fn.id);
    const imports = importsOf.get(fileId);
    const scope = context.factsByFile.get(fileId)?.nested[fn.id] ?? null;
    for (const decorator of decorators) {
      const last = decorator.name.split(".").at(-1)!;
      if (last !== "command" && last !== "group") continue;
      const receiver = decorator.name.includes(".") ? decorator.name.slice(0, decorator.name.lastIndexOf(".")) : null;
      const explicit = context.literal(decorator.positional[0] ?? decorator.kwargs.name, fileId);
      const functionName = String(fn.properties.name);
      let library: CliNode["library"] | null = null;
      let typer: string | null = null;
      let parentFunction: string | null = null;
      if (receiver !== null && /\.cli$/u.test(receiver)) library = "flask";
      else if (receiver === "click" || (receiver === null && imports?.has("click"))) library = "click";
      else if (receiver !== null && (imports?.has("click") || imports?.has("typer"))) {
        const app = resolveTyper(receiver, fileId, scope);
        if (app) {
          library = "typer";
          typer = app.key;
        } else {
          const parent = index.lookupFunction(receiver, fileId);
          if (parent) {
            library = "click";
            parentFunction = parent;
          }
        }
      }
      if (!library) continue;
      cli.set(fn.id, {
        id: fn.id, functionId: fn.id, fileId, name: clickName(explicit, functionName, library), kind: last === "group" ? "group" : "command",
        library, line: Number(fn.properties.line), parent: null, typer,
      });
      if (parentFunction) cli.get(fn.id)!.parent = { id: parentFunction } as CliNode;
      break;
    }
  }
  // `group.add_command(cmd, name=..)`.
  for (const [fileId, calls] of context.callsByFile) {
    for (const call of calls) {
      if (call.callee.split(".").at(-1) !== "add_command" || !call.args[0]) continue;
      const childId = index.lookupFunction(call.args[0], fileId);
      const child = childId ? cli.get(childId) : undefined;
      if (!child) continue;
      const receiver = call.callee.slice(0, call.callee.lastIndexOf("."));
      const name = context.literal(call.kwargs.name ?? call.args[1], fileId);
      if (name) child.name = name;
      if (/\.cli$/u.test(receiver)) {
        child.library = "flask";
        continue;
      }
      const parentId = index.lookupFunction(receiver, fileId);
      if (parentId && cli.has(parentId)) child.parent = { id: parentId } as CliNode;
    }
  }
  for (const node of cli.values()) {
    if (node.parent) node.parent = cli.get(node.parent.id) ?? null;
  }

  const pathOf = (node: CliNode): string => {
    const segments: string[] = [node.name];
    const guard = new Set([node.id]);
    for (let parent = node.parent; parent?.parent; parent = parent.parent) {
      if (guard.has(parent.id)) break;
      guard.add(parent.id);
      segments.unshift(parent.name);
    }
    if (node.typer) {
      for (let app: Typer | undefined = typers.get(node.typer); app?.parent; app = app.parent.typer) if (app.parent.name) segments.unshift(app.parent.name);
    }
    return segments.join(" ");
  };
  for (const node of cli.values()) {
    entrypoint(node.fileId, "cli", pathOf(node), node.library, node.line, String(context.nodeById.get(node.functionId)?.properties.name), node.functionId);
  }
  for (const [fileId, calls] of context.callsByFile) {
    if (!importsOf.get(fileId)?.has("typer")) continue;
    for (const call of calls) {
      if (call.callee !== "typer.run" && call.callee !== "run") continue;
      const functionId = call.args[0] ? index.lookupFunction(call.args[0], fileId) : null;
      if (!functionId || cli.has(functionId)) continue;
      const name = String(context.nodeById.get(functionId)?.properties.name);
      entrypoint(fileId, "cli", name.replace(/_/gu, "-"), "typer", call.line, name, functionId);
    }
  }

  // ---- Django management commands -------------------------------------------
  for (const [relative, fileId] of context.fileIds) {
    const match = /(?:^|\/)management\/commands\/([A-Za-z]\w*)\.py$/u.exec(relative);
    if (!match) continue;
    const classId = index.classByFileAndName.get(fileId)?.get("Command");
    if (!classId) continue;
    const bases = context.classChain(classId).bases;
    if (![...bases].some((base) => /^(?:BaseCommand|AppCommand|LabelCommand|NoArgsCommand|\w+Command)$/u.test(base))) continue;
    const handle = context.findMethod(classId, "handle") ?? context.findMethod(classId, "handle_label") ?? context.findMethod(classId, "handle_app_config");
    entrypoint(fileId, "cli", match[1]!, "django", Number(context.nodeById.get(classId)?.properties.line ?? 1), "handle", handle, "Command");
  }

  graph.addNodes(nodes);
  graph.addRelationships(relationships);
}
