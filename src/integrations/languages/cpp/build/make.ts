import path from "node:path";
import type { BuildTarget, TargetType } from "./types.js";

// Reads the compile and link rules of Makefiles for C and C++ projects: which
// executables and libraries a Makefile builds, from which sources, and with
// which `-I` and `-D` flags. Variables (`=`, `:=`, `?=`, `+=`), `include` of
// local files, pattern rules, `VPATH` and the common text functions
// (`wildcard`, `patsubst`, `subst`, `addprefix`, `addsuffix`, `notdir`, `dir`,
// `basename`, `filter`, `filter-out`, `sort`, `strip`, `$(VAR:.c=.o)`) are
// understood; `$(shell ...)`, `$(call ...)`, `$(foreach ...)` and `$(eval ...)`
// are not, and every branch of an `ifeq`/`ifdef` is read. A recipe that runs a
// compiler without `-c` and with `-o` is a link, `ar` makes a static library.

export type MakeInput = {
  files: ReadonlySet<string>;
  // Makefile (relative path) → text.
  texts: ReadonlyMap<string, string>;
};

export type MakeResult = {
  targets: BuildTarget[];
  includeDirsByFile: Map<string, string[]>;
  definitionsByFile: Map<string, Map<string, string>>;
  files: string[];
  unresolved: number;
};

type Rule = {
  targets: string[];
  prereqs: string[];
  recipe: string[];
  line: number;
};

const SOURCE_EXTENSIONS = [".c", ".cc", ".cpp", ".cxx", ".C", ".c++"];
const COMPILER = /^(?:[\w+.-]*-)?(?:gcc|g\+\+|cc|c\+\+|clang|clang\+\+|icc|icpc|mpicc|mpicxx|ld)$/u;
const ARCHIVER = /^(?:[\w+.-]*-)?(?:ar|llvm-ar|gcc-ar)$/u;

export function interpretMakefiles(input: MakeInput): MakeResult {
  const result: MakeResult = { targets: [], includeDirsByFile: new Map(), definitionsByFile: new Map(), files: [], unresolved: 0 };
  for (const [file, text] of [...input.texts].sort(([a], [b]) => a.localeCompare(b))) {
    wildcardFiles = input.files;
    wildcardDirectory = dirOf(file);
    const state = readMakefile(file, text, input);
    if (state.rules.length === 0 && state.vars.size === 0) continue;
    result.files.push(file);
    buildTargets(file, state, input, result);
  }
  return result;
}

type State = {
  vars: Map<string, string>;
  rules: Rule[];
  // `%.o: %.c` style rules.
  patterns: Rule[];
  vpaths: Array<{ pattern: RegExp; dirs: string[] }>;
  unresolved: number;
};

// Logical lines (continuations joined, comments dropped) with their first physical line.
function logicalLines(text: string): Array<{ text: string; line: number }> {
  const physical = text.split(/\r?\n/u);
  const lines: Array<{ text: string; line: number }> = [];
  for (let index = 0; index < physical.length; index += 1) {
    let current = physical[index]!;
    const line = index + 1;
    while (/(?:^|[^\\])(?:\\\\)*\\$/u.test(current) && index + 1 < physical.length) {
      current = `${current.slice(0, -1)} ${physical[++index]!.replace(/^\t+/u, "").trim()}`;
    }
    lines.push({ text: current, line });
  }
  return lines;
}

function stripComment(line: string): string {
  let result = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === "\\" && line[index + 1] === "#") {
      result += "#";
      index += 1;
    } else if (char === "#") break;
    else result += char;
  }
  return result;
}

function readMakefile(file: string, text: string, input: MakeInput): State {
  const state: State = { vars: new Map(), rules: [], patterns: [], vpaths: [], unresolved: 0 };
  const directory = dirOf(file);
  const visited = new Set<string>([file]);
  const feed = (source: string, depth: number) => {
    let current: Rule[] = [];
    let inDefine = false;
    for (const logical of logicalLines(source)) {
      const raw = logical.text;
      if (inDefine) {
        if (/^\s*endef\b/u.test(raw)) inDefine = false;
        continue;
      }
      if (raw.startsWith("\t") && current.length > 0) {
        const recipe = raw.replace(/^\t+/u, "").trim();
        if (recipe !== "" && !recipe.startsWith("#")) for (const rule of current) rule.recipe.push(recipe.replace(/^[@\-+]+/u, "").trim());
        continue;
      }
      const line = stripComment(raw).trim();
      if (line === "") continue;
      // A tab-indented line outside a rule is an ordinary line (an assignment inside a conditional), never a rule.
      if (raw.startsWith("\t") && !/^(?:(?:export|override|private)\s+)*[A-Za-z_][\w.-]*\s*(?:::=|:=|\?=|\+=|!=|=)/u.test(line) && !/^(?:ifeq|ifneq|ifdef|ifndef|else|endif|-?include)\b/u.test(line)) continue;
      if (/^define\b/u.test(line)) {
        inDefine = true;
        current = [];
        continue;
      }
      if (/^(?:ifeq|ifneq|ifdef|ifndef|else|endif)\b/u.test(line)) {
        // Every branch is read; the condition is not evaluated.
        current = [];
        continue;
      }
      const include = /^(-?include|sinclude)\s+(.+)$/u.exec(line);
      if (include) {
        current = [];
        if (depth > 5) continue;
        for (const name of expand(include[2]!, state.vars, {}, state).value.split(/\s+/u).filter(Boolean)) {
          const target = joinRel(directory, name);
          const text = input.texts.get(target);
          if (text !== undefined && !visited.has(target)) {
            visited.add(target);
            feed(text, depth + 1);
          }
        }
        continue;
      }
      const vpath = /^vpath\s+(\S+)\s+(.+)$/u.exec(line);
      if (vpath) {
        state.vpaths.push({ pattern: patternRegex(vpath[1]!), dirs: vpath[2]!.split(/[:\s]+/u).filter(Boolean) });
        continue;
      }
      const assignment = /^(?:(?:export|override|private)\s+)*([A-Za-z_][\w.-]*)\s*(::=|:=|\?=|\+=|!=|=)\s*(.*)$/u.exec(line);
      if (assignment) {
        current = [];
        const [, name, operator, value] = assignment as unknown as [string, string, string, string];
        if (operator === "!=") state.vars.set(name, "");
        else if (operator === "?=") {
          if (!state.vars.has(name)) state.vars.set(name, value);
        } else if (operator === "+=") {
          const before = state.vars.get(name);
          state.vars.set(name, before === undefined || before === "" ? value : `${before} ${value}`);
        } else if (operator === ":=" || operator === "::=") {
          state.vars.set(name, expand(value, state.vars, {}, state).value);
        } else state.vars.set(name, value);
        continue;
      }
      const rule = splitRule(line);
      if (!rule) {
        current = [];
        continue;
      }
      current = [];
      const targets = expand(rule.targets, state.vars, {}, state).value.split(/\s+/u).filter(Boolean);
      if (targets.length === 0 || targets.every((target) => target.startsWith(".") && !target.includes("/"))) continue;
      const prereqText = rule.prereqs;
      // Static pattern rule `objs: %.o: %.c`: the pattern rule applies to the listed targets.
      const staticPattern = /^([^:]*%[^:]*):(.*)$/u.exec(prereqText);
      const expanded = expand(staticPattern ? staticPattern[2]! : prereqText, state.vars, {}, state).value;
      const prereqs = expanded.split("|")[0]!.split(/\s+/u).filter(Boolean);
      const entry: Rule = { targets: staticPattern ? [expand(staticPattern[1]!, state.vars, {}, state).value.trim()] : targets, prereqs, recipe: [], line: logical.line };
      if (rule.recipe) entry.recipe.push(rule.recipe);
      if (entry.targets.some((target) => target.includes("%"))) state.patterns.push(entry);
      else state.rules.push(entry);
      current = [entry];
    }
  };
  feed(text, 0);
  return state;
}

// `targets : prerequisites ; recipe`, or null (not a rule).
function splitRule(line: string): { targets: string; prereqs: string; recipe: string | null } | null {
  // The first `:` outside `$(...)`, not `:=`.
  let depth = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === "(" || char === "{") depth += 1;
    else if (char === ")" || char === "}") depth -= 1;
    else if (char === ":" && depth === 0) {
      if (line[index + 1] === "=" || line[index - 1] === ":" || (line[index + 1] === ":" && line[index + 2] === "=")) return null;
      const targets = line.slice(0, index).trim();
      let rest = line.slice(index + (line[index + 1] === ":" ? 2 : 1));
      let recipe: string | null = null;
      const semicolon = rest.indexOf(";");
      if (semicolon !== -1) {
        recipe = rest.slice(semicolon + 1).trim();
        rest = rest.slice(0, semicolon);
      }
      return targets === "" ? null : { targets, prereqs: rest.trim(), recipe };
    }
  }
  return null;
}

type Autos = { at?: string; first?: string; all?: string };

// Expands `$(VAR)`, `${VAR}`, `$X`, `$$` and the text functions in `text`.
function expand(text: string, vars: Map<string, string>, autos: Autos, state: { unresolved: number }, depth = 0): { value: string } {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char !== "$") {
      out += char;
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) {
      out += "$";
      break;
    }
    if (next === "$") {
      out += "$";
      index += 1;
      continue;
    }
    if (next === "(" || next === "{") {
      const close = next === "(" ? ")" : "}";
      let nesting = 1;
      let end = index + 2;
      while (end < text.length && nesting > 0) {
        if (text[end] === next) nesting += 1;
        else if (text[end] === close) nesting -= 1;
        end += 1;
      }
      const inner = text.slice(index + 2, end - 1);
      index = end - 1;
      out += evaluate(inner, vars, autos, state, depth);
      continue;
    }
    // `$@`, `$<`, `$^`, `$+`, `$?`, `$*` and single-letter variables.
    index += 1;
    if (next === "@") out += autos.at ?? "";
    else if (next === "<") out += autos.first ?? "";
    else if (next === "^" || next === "+" || next === "?") out += autos.all ?? "";
    else if (next === "*") out += "";
    else out += lookup(next, vars, autos, state, depth);
  }
  return { value: out };
}

function lookup(name: string, vars: Map<string, string>, autos: Autos, state: { unresolved: number }, depth: number): string {
  const raw = vars.get(name);
  if (raw === undefined) {
    if (name === "MAKE" || name === "CURDIR") return name === "MAKE" ? "make" : ".";
    if (["CC", "CXX", "AR", "LD", "CPP", "RM"].includes(name)) return { CC: "cc", CXX: "c++", AR: "ar", LD: "ld", CPP: "cc -E", RM: "rm -f" }[name]!;
    if (!(name in process.env) && !["CFLAGS", "CXXFLAGS", "CPPFLAGS", "LDFLAGS", "LDLIBS", "LIBS", "ARFLAGS"].includes(name)) state.unresolved += 1;
    return "";
  }
  if (depth > 20) return "";
  return expand(raw, vars, autos, state, depth + 1).value;
}

const words = (value: string): string[] => value.split(/\s+/u).filter(Boolean);

function evaluate(inner: string, vars: Map<string, string>, autos: Autos, state: { unresolved: number }, depth: number): string {
  const call = /^([a-z-]+)\s+([\s\S]*)$/u.exec(inner);
  if (call) {
    const args = splitArguments(call[2]!).map((argument) => expand(argument, vars, autos, state, depth + 1).value);
    const fn = call[1]!;
    switch (fn) {
      case "wildcard":
        return words(args.join(",")).flatMap((pattern) => wildcardMatches(pattern, vars, state)).join(" ");
      case "patsubst":
        return words(args[2] ?? "").map((word) => substitutePattern(word, args[0] ?? "", args[1] ?? "")).join(" ");
      case "subst":
        return (args[2] ?? "").split(args[0] ?? "\0").join(args[1] ?? "");
      case "addprefix":
        return words(args[1] ?? "").map((word) => `${args[0] ?? ""}${word}`).join(" ");
      case "addsuffix":
        return words(args[1] ?? "").map((word) => `${word}${args[0] ?? ""}`).join(" ");
      case "notdir":
        return words(args[0] ?? "").map((word) => word.slice(word.lastIndexOf("/") + 1)).join(" ");
      case "dir":
        return words(args[0] ?? "").map((word) => word.includes("/") ? word.slice(0, word.lastIndexOf("/") + 1) : "./").join(" ");
      case "basename":
        return words(args[0] ?? "").map((word) => word.replace(/\.[^./]*$/u, "")).join(" ");
      case "suffix":
        return words(args[0] ?? "").map((word) => /\.[^./]*$/u.exec(word)?.[0] ?? "").join(" ");
      case "strip":
        return words(args[0] ?? "").join(" ");
      case "sort":
        return [...new Set(words(args[0] ?? ""))].sort().join(" ");
      case "firstword":
        return words(args[0] ?? "")[0] ?? "";
      case "filter":
      case "filter-out": {
        const patterns = words(args[0] ?? "").map(patternRegex);
        return words(args[1] ?? "").filter((word) => patterns.some((pattern) => pattern.test(word)) === (fn === "filter")).join(" ");
      }
      case "abspath":
      case "realpath":
        return args[0] ?? "";
      default:
        // shell, call, foreach, eval, if, origin, ...: not read.
        state.unresolved += 1;
        return "";
    }
  }
  // `$(VAR:.c=.o)` and `$(VAR:%.c=%.o)`.
  const reference = /^([^:\s]+):([^=]+)=(.*)$/u.exec(inner);
  if (reference) {
    const value = lookup(reference[1]!, vars, autos, state, depth);
    const from = reference[2]!;
    const to = reference[3]!;
    return words(value).map((word) => substitutePattern(word, from.includes("%") ? from : `%${from}`, to.includes("%") || !from.includes("%") ? (to.includes("%") ? to : `%${to}`) : to)).join(" ");
  }
  const name = expand(inner, vars, autos, state, depth + 1).value;
  if (name === "@") return autos.at ?? "";
  if (name === "<") return autos.first ?? "";
  if (name === "^" || name === "+" || name === "?") return autos.all ?? "";
  if (name === "@D") return autos.at?.includes("/") ? autos.at.slice(0, autos.at.lastIndexOf("/")) : ".";
  return lookup(name, vars, autos, state, depth);
}

// Top-level comma-separated arguments of a function call.
function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "{") depth += 1;
    else if (char === ")" || char === "}") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim());
}

function patternRegex(pattern: string): RegExp {
  const parts = pattern.split("%");
  return new RegExp(`^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("(.+)")}$`, "u");
}

function substitutePattern(word: string, from: string, to: string): string {
  if (!from.includes("%")) return word === from ? to : word;
  const match = patternRegex(from).exec(word);
  return match ? to.replace("%", match[1]!) : word;
}

// `$(wildcard src/*.c)`: the scanned files the pattern matches (the scan, not the disk).
let wildcardFiles: ReadonlySet<string> = new Set();
let wildcardDirectory = "";

function wildcardMatches(pattern: string, _vars: Map<string, string>, _state: { unresolved: number }): string[] {
  const full = joinRel(wildcardDirectory, pattern);
  const slash = full.lastIndexOf("/");
  const directory = slash === -1 ? "" : full.slice(0, slash);
  const regex = new RegExp(`^${full.slice(slash + 1).replace(/[.+^${}()|\\]/gu, "\\$&").replace(/\*/gu, "[^/]*").replace(/\?/gu, "[^/]")}$`, "u");
  const matches: string[] = [];
  for (const file of wildcardFiles) {
    if (dirOf(file) === directory && regex.test(path.posix.basename(file))) matches.push(joinRel(slash === -1 ? "" : pattern.slice(0, pattern.lastIndexOf("/")), path.posix.basename(file)).replace(/^\.\//u, ""));
  }
  return matches.sort();
}

function dirOf(file: string): string {
  const directory = path.posix.dirname(file);
  return directory === "." ? "" : directory;
}

function joinRel(directory: string, name: string): string {
  const joined = path.posix.normalize(directory === "" ? name : path.posix.join(directory, name));
  return joined === "." ? "" : joined;
}

// ---- Targets

type Compile = { dirs: string[]; definitions: Map<string, string> };

function buildTargets(file: string, state: State, input: MakeInput, result: MakeResult): void {
  const directory = dirOf(file);
  const files = input.files;
  const exists = (relative: string) => files.has(joinRel(directory, relative));
  const global = state.vars;
  const counter = { unresolved: 0 };

  const flagVariables = (extension: string) => extension === ".c" ? ["CPPFLAGS", "CFLAGS"] : ["CPPFLAGS", "CXXFLAGS"];
  const compileFlags = (tokens: string[]): Compile => {
    const dirs: string[] = [];
    const definitions = new Map<string, string>();
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      let value: string | null = null;
      if (token === "-I" || token === "-isystem" || token === "-iquote" || token === "-idirafter") {
        value = tokens[index + 1] ?? null;
        index += 1;
      } else if (/^-(?:I|isystem|iquote|idirafter)./u.test(token)) {
        value = token.replace(/^-(?:isystem|iquote|idirafter|I)/u, "");
      } else if (token === "-D") {
        const definition = tokens[index + 1];
        index += 1;
        if (definition) addDefinition(definitions, definition);
        continue;
      } else if (token.startsWith("-D") && token.length > 2) {
        addDefinition(definitions, token.slice(2));
        continue;
      }
      if (value !== null && value !== "") {
        const dir = joinRel(directory, value.replace(/^["']|["']$/gu, ""));
        if (!dir.startsWith("..") && !path.posix.isAbsolute(dir) && !dirs.includes(dir)) dirs.push(dir);
      }
    }
    return { dirs, definitions };
  };

  // Rules by target, and the source an object is built from.
  const byTarget = new Map<string, Rule>();
  for (const rule of state.rules) for (const target of rule.targets) if (!byTarget.has(target) || byTarget.get(target)!.recipe.length === 0) byTarget.set(target, rule);

  const vpathDirs = (name: string): string[] => {
    const dirs = [...(global.get("VPATH")?.split(/[:\s]+/u).filter(Boolean) ?? [])];
    for (const entry of state.vpaths) if (entry.pattern.test(name)) dirs.unshift(...entry.dirs);
    return dirs;
  };
  const findSource = (name: string): string | null => {
    if (exists(name)) return joinRel(directory, name);
    for (const dir of vpathDirs(path.posix.basename(name))) {
      if (exists(`${dir}/${path.posix.basename(name)}`)) return joinRel(directory, `${dir}/${path.posix.basename(name)}`);
    }
    return null;
  };
  const objectExtensions = [".o", ".obj"];
  const compileRuleFor = (object: string): { source: string; rule: Rule | null } | null => {
    const explicit = byTarget.get(object);
    const prereqSource = explicit?.prereqs.find((prereq) => SOURCE_EXTENSIONS.includes(path.posix.extname(prereq)));
    if (explicit && prereqSource) {
      const source = findSource(prereqSource);
      if (source) return { source, rule: explicit.recipe.length > 0 ? explicit : patternFor(object, state)?.rule ?? null };
    }
    for (const pattern of state.patterns) {
      for (const target of pattern.targets) {
        const match = patternRegex(target).exec(object);
        if (!match) continue;
        for (const prereq of pattern.prereqs) {
          if (!SOURCE_EXTENSIONS.includes(path.posix.extname(prereq.replace("%", match[1]!)))) continue;
          const source = findSource(prereq.replace("%", match[1]!));
          if (source) return { source, rule: pattern };
        }
      }
    }
    // Built-in rule: `x.o` from `x.c`, `x.cc`, ... next to it.
    const stem = object.replace(/\.(?:o|obj)$/u, "");
    for (const extension of SOURCE_EXTENSIONS) {
      const source = findSource(`${stem}${extension}`);
      if (source) return { source, rule: null };
    }
    // The object lives in another directory than its source (`build/x.o` from `src/x.c`): by stem under VPATH.
    const base = path.posix.basename(stem);
    for (const dir of vpathDirs(`${base}.c`)) {
      for (const extension of SOURCE_EXTENSIONS) {
        const source = findSource(`${dir}/${base}${extension}`);
        if (source) return { source, rule: null };
      }
    }
    return null;
  };

  const compileFor = new Map<string, Compile>();
  const noteCompile = (source: string, flags: Compile) => {
    const known = compileFor.get(source);
    if (!known) compileFor.set(source, flags);
    else {
      for (const dir of flags.dirs) if (!known.dirs.includes(dir)) known.dirs.push(dir);
      for (const [name, value] of flags.definitions) known.definitions.set(name, value);
    }
  };
  const flagsOfRule = (rule: Rule | null, source: string, object: string): Compile => {
    const extension = path.posix.extname(source);
    const autos: Autos = { at: object, first: source, all: source };
    const tokens: string[] = [];
    if (rule && rule.recipe.length > 0) {
      for (const line of rule.recipe) tokens.push(...words(expand(line, global, autos, counter).value));
    } else {
      for (const variable of flagVariables(extension)) tokens.push(...words(expand(`$(${variable})`, global, autos, counter).value));
    }
    return compileFlags(tokens);
  };

  const objectsToSources = (tokens: string[]): string[] => {
    const sources: string[] = [];
    for (const token of tokens) {
      const extension = path.posix.extname(token);
      if (objectExtensions.includes(extension)) {
        const found = compileRuleFor(token);
        if (!found) {
          result.unresolved += 1;
          continue;
        }
        noteCompile(found.source, flagsOfRule(found.rule, found.source, token));
        if (!sources.includes(found.source)) sources.push(found.source);
      } else if (SOURCE_EXTENSIONS.includes(extension)) {
        const source = findSource(token);
        if (source && !sources.includes(source)) sources.push(source);
      }
    }
    return sources;
  };

  const linked = new Map<string, BuildTarget>();
  const linkTokens = new Map<string, string[]>();
  for (const rule of state.rules) {
    for (const target of rule.targets) {
      if (rule.recipe.length === 0 || linked.has(target)) continue;
      const autos: Autos = { at: target, first: rule.prereqs[0] ?? "", all: [...new Set(rule.prereqs)].join(" ") };
      for (const line of rule.recipe) {
        const tokens = words(expand(line, global, autos, counter).value);
        const program = tokens[0] === "ccache" ? tokens[1] : tokens[0];
        if (!program) continue;
        const name = path.posix.basename(program);
        let type: TargetType | null = null;
        if (COMPILER.test(name)) {
          const output = tokens.indexOf("-o");
          if (output === -1 || tokens.includes("-c") || tokens.includes("-S") || tokens.includes("-E")) continue;
          if (tokens[output + 1] !== target && path.posix.basename(tokens[output + 1] ?? "") !== path.posix.basename(target)) continue;
          type = tokens.includes("-shared") || tokens.includes("-dynamiclib") ? "shared" : "executable";
        } else if (ARCHIVER.test(name)) {
          type = "static";
        } else continue;
        const sources = objectsToSources(tokens.slice(1));
        // One command compiles and links: its flags apply to the sources it names.
        if (type !== "static") {
          const direct = compileFlags(tokens);
          for (const source of sources) if (tokens.some((token) => findSource(token) === source)) noteCompile(source, direct);
        }
        if (sources.length === 0) continue;
        const built: BuildTarget = {
          system: "make",
          name: target,
          type,
          dir: directory,
          file,
          line: rule.line,
          sources,
          links: [],
          includePrivate: [],
          includeInterface: [],
          definitionsPrivate: [],
          definitionsInterface: [],
          unresolved: 0,
        };
        linked.set(target, built);
        linkTokens.set(target, tokens.slice(1));
        break;
      }
    }
  }

  // The built-in rule `%: %.c`: `app: app.c libx.a` with no recipe links an executable.
  for (const rule of state.rules) {
    for (const target of rule.targets) {
      if (linked.has(target) || path.posix.extname(target) !== "" || rule.recipe.length > 0) continue;
      if (state.rules.some((other) => other.targets.includes(target) && other.recipe.length > 0)) continue;
      const tokens = [...rule.prereqs];
      const sources = objectsToSources(tokens);
      if (sources.length === 0) continue;
      for (const source of sources) {
        if (tokens.some((token) => findSource(token) === source)) noteCompile(source, flagsOfRule(null, source, target));
      }
      linked.set(target, {
        system: "make", name: target, type: "executable", dir: directory, file, line: rule.line, sources,
        links: [], includePrivate: [], includeInterface: [], definitionsPrivate: [], definitionsInterface: [], unresolved: 0,
      });
      linkTokens.set(target, tokens);
    }
  }

  // Links: an archive or shared library of this Makefile, named as a file or with `-l`.
  const byOutput = new Map<string, BuildTarget>();
  for (const target of linked.values()) byOutput.set(path.posix.basename(target.name), target);
  for (const target of linked.values()) {
    for (const token of linkTokens.get(target.name) ?? []) {
      let other: BuildTarget | undefined;
      if (token.startsWith("-l")) {
        const name = token.slice(2);
        other = byOutput.get(`lib${name}.a`) ?? byOutput.get(`lib${name}.so`) ?? byOutput.get(`lib${name}.dylib`);
      } else if (/\.(?:a|so|dylib)$/u.test(token)) other = byOutput.get(path.posix.basename(token));
      if (other && other !== target && !target.links.some((link) => link.target === `make:${other!.name}`)) target.links.push({ target: `make:${other.name}`, visibility: "public" });
    }
    for (const source of target.sources) {
      const flags = compileFor.get(source);
      if (!flags) continue;
      for (const dir of flags.dirs) if (!target.includePrivate.includes(dir)) target.includePrivate.push(dir);
      for (const [name, value] of flags.definitions) {
        const entry = value === "" ? name : `${name}=${value}`;
        if (!target.definitionsPrivate.includes(entry)) target.definitionsPrivate.push(entry);
      }
    }
    result.targets.push(target);
  }
  for (const [source, flags] of compileFor) {
    const known = result.includeDirsByFile.get(source);
    result.includeDirsByFile.set(source, known ? [...new Set([...known, ...flags.dirs])] : flags.dirs);
    const definitions = result.definitionsByFile.get(source) ?? new Map<string, string>();
    for (const [name, value] of flags.definitions) definitions.set(name, value);
    if (definitions.size > 0) result.definitionsByFile.set(source, definitions);
  }
  result.unresolved += counter.unresolved + state.unresolved;
}

function patternFor(object: string, state: State): { rule: Rule } | null {
  for (const pattern of state.patterns) {
    if (pattern.targets.some((target) => patternRegex(target).test(object))) return { rule: pattern };
  }
  return null;
}

function addDefinition(definitions: Map<string, string>, text: string): void {
  const equals = text.indexOf("=");
  if (equals === -1) definitions.set(text, "");
  else definitions.set(text.slice(0, equals), text.slice(equals + 1));
}
