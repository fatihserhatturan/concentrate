import path from "node:path";
import { readCMake, type CMakeCommand, type CMakeRead } from "../../plain/cmake.js";
import type { BuildTarget, TargetType } from "./types.js";

// Interprets the commands of `CMakeLists.txt` files that decide the targets of a
// C or C++ project: `project`, `set`, `option`, `list(APPEND)`, `file(GLOB)`,
// `aux_source_directory`, `include` of a local `.cmake` file, `foreach`,
// `add_subdirectory`, `add_executable`, `add_library`, `target_sources`,
// `target_link_libraries`, `include_directories`, `target_include_directories`,
// `add_definitions`, `add_compile_definitions` and `target_compile_definitions`.
//
// Honest limits: every branch of an `if` runs (conditions are not evaluated),
// functions and macros are not expanded, `foreach(... RANGE ...)` is skipped,
// and generator expressions other than `$<BUILD_INTERFACE:>`,
// `$<INSTALL_INTERFACE:>` and `$<TARGET_OBJECTS:>` are not read. An argument
// that names an unset variable, such an expression or a file the scan does not
// have is counted in `unresolved` and left out.

export type CMakeInput = {
  rootPath: string;
  // Every scanned file, relative to the root.
  files: ReadonlySet<string>;
  // Source text of the `CMakeLists.txt` and `.cmake` files, by relative path.
  texts: ReadonlyMap<string, string>;
};

export type CMakeResult = {
  targets: BuildTarget[];
  // CMake files that were interpreted.
  files: string[];
  unresolved: number;
  // Reads of the files with a syntax error (the plain parser reports them).
  errors: number;
};

type Scope = {
  vars: Map<string, string>;
  sourceDir: string; // absolute
  binaryDir: string; // absolute, under a marker that is never a scanned path
  // include_directories / add_definitions of this directory (inherited by children).
  dirIncludes: string[];
  dirDefinitions: string[];
  // Targets created in this directory: later directory-level commands reach them too.
  targets: BuildTarget[];
  isRoot: boolean;
};

const BUILD_MARKER = "/__cmake-build__";
const SOURCE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx", ".c++", ".C", ".m", ".mm"]);
const HEADER_EXTENSIONS = new Set([".h", ".hh", ".hpp", ".hxx", ".h++", ".inl", ".ipp", ".tpp"]);
const LIBRARY_KEYWORDS = new Set(["STATIC", "SHARED", "MODULE", "OBJECT", "INTERFACE", "EXCLUDE_FROM_ALL", "IMPORTED", "GLOBAL", "UNKNOWN", "ALIAS"]);
const EXECUTABLE_KEYWORDS = new Set(["WIN32", "MACOSX_BUNDLE", "EXCLUDE_FROM_ALL", "IMPORTED", "GLOBAL", "ALIAS"]);
const VISIBILITY = new Set(["PUBLIC", "PRIVATE", "INTERFACE"]);

export function isCppSourceFile(file: string): boolean {
  return SOURCE_EXTENSIONS.has(path.posix.extname(file));
}

export function isCppHeaderFile(file: string): boolean {
  return HEADER_EXTENSIONS.has(path.posix.extname(file));
}

export function interpretCMake(input: CMakeInput): CMakeResult {
  const reads = new Map<string, CMakeRead>();
  let errors = 0;
  for (const [file, text] of input.texts) {
    const read = readCMake(text);
    errors += read.errors.length;
    reads.set(file, read);
  }

  const targets = new Map<string, BuildTarget>();
  const aliases = new Map<string, string>();
  const interpreted = new Set<string>();
  let unresolved = 0;
  const root = input.rootPath;
  const relative = (absolute: string): string | null => {
    if (absolute.startsWith(BUILD_MARKER)) return null;
    const value = path.relative(root, absolute).split(path.sep).join("/");
    return value.startsWith("..") || path.isAbsolute(value) ? null : value;
  };
  const absoluteOf = (dir: string) => path.join(root, dir);

  // The directories a `CMakeLists.txt` reaches through `add_subdirectory` are
  // not roots; the others are (a repository can hold several projects).
  const subdirectories = new Set<string>();
  for (const [file, read] of reads) {
    if (path.posix.basename(file) !== "CMakeLists.txt") continue;
    const dir = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
    for (const command of read.commands) {
      if (command.name !== "add_subdirectory" || !command.args[0] || /[${]/u.test(command.args[0].text)) continue;
      subdirectories.add(path.posix.normalize(path.posix.join(dir, command.args[0].text)).replace(/^\.$/u, ""));
    }
  }

  type Value = { values: string[]; unresolved: number };

  // `${A}`, nested `${A_${B}}` and `$ENV{A}` replaced in `text`; a name with no
  // value is empty and counted.
  const substitute = (text: string, scope: Scope): { value: string; unresolved: number; opaque: boolean } => {
    let missing = 0;
    let value = text;
    // Generator expressions: the build-tree form of an include directory is
    // the path itself; the install form is gone; anything else is opaque.
    value = value.replace(/\$<BUILD_INTERFACE:([^<>]*)>/gu, "$1").replace(/\$<INSTALL_INTERFACE:[^<>]*>/gu, "");
    for (let round = 0; round < 40; round += 1) {
      const match = /\$(ENV)?\{([^${}]*)\}/u.exec(value);
      if (!match) break;
      let replacement = "";
      if (match[1]) missing += 1;
      else {
        const found = lookup(match[2]!, scope);
        if (found === null) missing += 1;
        else replacement = found;
      }
      value = value.slice(0, match.index) + replacement + value.slice(match.index + match[0].length);
    }
    return { value, unresolved: missing, opaque: /\$<|\$\{|\$ENV\{/u.test(value) };
  };

  const lookup = (name: string, scope: Scope): string | null => {
    const found = scope.vars.get(name);
    if (found !== undefined) return found;
    switch (name) {
      case "CMAKE_CURRENT_SOURCE_DIR":
      case "CMAKE_CURRENT_LIST_DIR":
        return scope.sourceDir;
      case "CMAKE_CURRENT_BINARY_DIR":
        return scope.binaryDir;
      case "CMAKE_BINARY_DIR":
      case "PROJECT_BINARY_DIR":
        return BUILD_MARKER;
      case "CMAKE_SOURCE_DIR":
        return root;
      default:
        return null;
    }
  };

  // An argument as its list items (unquoted and quoted arguments both split
  // on `;`: sources and directories are the only lists read this way).
  const items = (command: CMakeCommand, from: number, scope: Scope, counted = true): Value => {
    const values: string[] = [];
    let missing = 0;
    for (const arg of command.args.slice(from)) {
      if (arg.bracket) {
        values.push(arg.text);
        continue;
      }
      const result = substitute(arg.text, scope);
      missing += result.unresolved;
      if (result.opaque) {
        if (counted) missing += 1;
        continue;
      }
      for (const part of result.value.split(";")) if (part !== "") values.push(part);
    }
    return { values, unresolved: missing };
  };

  const addUnresolved = (count: number, target?: BuildTarget) => {
    unresolved += count;
    if (target) target.unresolved += count;
  };

  // A path argument as an absolute path.
  const toAbsolute = (value: string, scope: Scope): string => path.isAbsolute(value) ? path.normalize(value) : path.normalize(path.join(scope.sourceDir, value));

  const directoryOf = (relativeFile: string) => path.posix.dirname(relativeFile) === "." ? "" : path.posix.dirname(relativeFile);

  const globFiles = (patterns: string[], scope: Scope, recurse: boolean, base: string | null): string[] => {
    const found = new Set<string>();
    for (const pattern of patterns) {
      const absolute = toAbsolute(pattern, scope);
      const relativePattern = relative(absolute);
      if (relativePattern === null) continue;
      const slash = relativePattern.lastIndexOf("/");
      const directory = slash === -1 ? "" : relativePattern.slice(0, slash);
      const namePattern = relativePattern.slice(slash + 1);
      const regex = globRegex(namePattern);
      const directoryRegex = recurse ? null : globRegex(directory);
      for (const file of input.files) {
        const fileDirectory = directoryOf(file);
        const inside = recurse
          ? directory === "" || fileDirectory === directory || fileDirectory.startsWith(`${directory}/`)
          : directoryRegex!.test(fileDirectory);
        if (inside && regex.test(path.posix.basename(file))) found.add(file);
      }
    }
    return [...found].sort().map((file) => base === null ? path.join(root, file) : path.relative(path.join(root, base), path.join(root, file)).split(path.sep).join("/"));
  };

  const defineTarget = (target: BuildTarget, scope: Scope): void => {
    if (targets.has(target.name)) return;
    targets.set(target.name, target);
    scope.targets.push(target);
    for (const dir of scope.dirIncludes) addUnique(target.includePrivate, dir);
    for (const definition of scope.dirDefinitions) addUnique(target.definitionsPrivate, definition);
  };

  const resolveTarget = (name: string): BuildTarget | undefined => targets.get(aliases.get(name) ?? name);

  const addSources = (target: BuildTarget, values: string[], scope: Scope): void => {
    for (const value of values) {
      const objects = /^\$<TARGET_OBJECTS:([^<>]+)>$/u.exec(value);
      if (objects) {
        const other = resolveTarget(objects[1]!);
        if (other) for (const source of other.sources) addUnique(target.sources, source);
        else addUnresolved(1, target);
        continue;
      }
      const file = relative(toAbsolute(value, scope));
      if (file !== null && input.files.has(file)) addUnique(target.sources, file);
      else addUnresolved(1, target);
    }
  };

  const run = (commands: CMakeCommand[], scope: Scope, file: string, depth: number): void => {
    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index]!;
      switch (command.name) {
        case "function":
        case "macro": {
          // Bodies are not expanded: skip to the matching end.
          const end = command.name === "function" ? "endfunction" : "endmacro";
          let nesting = 1;
          while (nesting > 0 && index + 1 < commands.length) {
            index += 1;
            const next = commands[index]!.name;
            if (next === command.name) nesting += 1;
            else if (next === end) nesting -= 1;
          }
          break;
        }
        case "foreach": {
          let nesting = 1;
          let end = index;
          while (nesting > 0 && end + 1 < commands.length) {
            end += 1;
            if (commands[end]!.name === "foreach") nesting += 1;
            else if (commands[end]!.name === "endforeach") nesting -= 1;
          }
          const body = commands.slice(index + 1, end);
          index = end;
          const variable = command.args[0]?.text;
          if (!variable) break;
          let values: Value;
          const second = command.args[1]?.text;
          if (second === "RANGE") break;
          if (second === "IN") {
            const keyword = command.args[2]?.text;
            const list = keyword === "LISTS"
              ? items({ ...command, args: command.args.slice(3).map((arg) => ({ ...arg, text: "${" + arg.text + "}", quoted: false, bracket: false })) }, 0, scope)
              : items(command, 3, scope);
            values = list;
          } else {
            values = items(command, 1, scope);
          }
          addUnresolved(values.unresolved);
          for (const value of values.values) {
            const saved = scope.vars.get(variable);
            scope.vars.set(variable, value);
            run(body, scope, file, depth);
            if (saved === undefined) scope.vars.delete(variable);
            else scope.vars.set(variable, saved);
          }
          break;
        }
        case "project": {
          const name = command.args[0] ? substitute(command.args[0].text, scope).value : "";
          if (name === "") break;
          scope.vars.set("PROJECT_NAME", name);
          scope.vars.set("PROJECT_SOURCE_DIR", scope.sourceDir);
          scope.vars.set(`${name}_SOURCE_DIR`, scope.sourceDir);
          if (scope.isRoot) {
            scope.vars.set("CMAKE_PROJECT_NAME", name);
            scope.vars.set("CMAKE_SOURCE_DIR", root);
          }
          break;
        }
        case "set": {
          const name = command.args[0] ? substitute(command.args[0].text, scope).value : "";
          if (name === "" || name.startsWith("ENV{")) break;
          const values: string[] = [];
          let parent = false;
          for (let at = 1; at < command.args.length; at += 1) {
            const arg = command.args[at]!;
            if (!arg.quoted && arg.text === "PARENT_SCOPE") {
              parent = true;
              continue;
            }
            if (!arg.quoted && arg.text === "CACHE") break;
            const result = arg.bracket ? { value: arg.text, unresolved: 0 } : substitute(arg.text, scope);
            if (result.value !== "" || arg.quoted) values.push(result.value);
          }
          // `set(VAR)` unsets; PARENT_SCOPE writes are not visible to this directory.
          if (command.args.length === 1) scope.vars.delete(name);
          else if (!parent) scope.vars.set(name, values.join(";"));
          if (name === "CMAKE_INCLUDE_CURRENT_DIR" && /^(ON|TRUE|YES|Y|1)$/iu.test(values[0] ?? "")) addDirectoryIncludes(scope, [relative(scope.sourceDir) ?? ""]);
          break;
        }
        case "option": {
          const name = command.args[0]?.text;
          if (name && !scope.vars.has(name)) scope.vars.set(name, /^(ON|TRUE|YES|Y|1)$/iu.test(command.args[2] ? substitute(command.args[2].text, scope).value : "OFF") ? "ON" : "OFF");
          break;
        }
        case "list": {
          const action = command.args[0]?.text.toUpperCase();
          const name = command.args[1] ? substitute(command.args[1].text, scope).value : "";
          if (name === "") break;
          const current = (scope.vars.get(name) ?? "").split(";").filter((value) => value !== "");
          if (action === "APPEND" || action === "PREPEND") {
            const added = items(command, 2, scope, false);
            scope.vars.set(name, (action === "APPEND" ? [...current, ...added.values] : [...added.values, ...current]).join(";"));
          } else if (action === "REMOVE_ITEM") {
            const removed = new Set(items(command, 2, scope, false).values);
            scope.vars.set(name, current.filter((value) => !removed.has(value)).join(";"));
          }
          break;
        }
        case "file": {
          const action = command.args[0]?.text.toUpperCase();
          if (action !== "GLOB" && action !== "GLOB_RECURSE") break;
          const name = command.args[1] ? substitute(command.args[1].text, scope).value : "";
          if (name === "") break;
          let base: string | null = null;
          const patterns: string[] = [];
          for (let at = 2; at < command.args.length; at += 1) {
            const text = command.args[at]!.text;
            if (text === "RELATIVE") {
              base = relative(toAbsolute(command.args[at + 1] ? substitute(command.args[at + 1]!.text, scope).value : ".", scope));
              at += 1;
            } else if (text === "CONFIGURE_DEPENDS" || text === "FOLLOW_SYMLINKS") {
              continue;
            } else if (text === "LIST_DIRECTORIES") {
              at += 1;
            } else {
              const result = substitute(text, scope);
              if (result.opaque) addUnresolved(1);
              else patterns.push(...result.value.split(";").filter((value) => value !== ""));
            }
          }
          scope.vars.set(name, globFiles(patterns, scope, action === "GLOB_RECURSE", base).join(";"));
          break;
        }
        case "aux_source_directory": {
          const directory = command.args[0] ? relative(toAbsolute(substitute(command.args[0].text, scope).value, scope)) : null;
          const name = command.args[1]?.text;
          if (name && directory !== null) {
            scope.vars.set(name, [...input.files].filter((file) => directoryOf(file) === directory && SOURCE_EXTENSIONS.has(path.posix.extname(file))).sort().map((file) => path.join(root, file)).join(";"));
          }
          break;
        }
        case "include": {
          if (depth > 20) break;
          const raw = command.args[0] ? substitute(command.args[0].text, scope) : null;
          if (!raw || raw.value === "" || raw.unresolved > 0) break;
          const candidate = relative(toAbsolute(raw.value.endsWith(".cmake") || raw.value.includes("/") ? raw.value : `${raw.value}.cmake`, scope));
          const read = candidate ? reads.get(candidate) : undefined;
          if (candidate && read) {
            interpreted.add(candidate);
            run(read.commands, scope, candidate, depth + 1);
          }
          break;
        }
        case "add_subdirectory": {
          if (depth > 40 || !command.args[0]) break;
          const result = substitute(command.args[0].text, scope);
          if (result.opaque || result.unresolved > 0 || result.value === "") {
            addUnresolved(1);
            break;
          }
          const directory = relative(toAbsolute(result.value, scope));
          const lists = directory === null ? undefined : `${directory === "" ? "" : `${directory}/`}CMakeLists.txt`;
          const read = lists ? reads.get(lists) : undefined;
          if (!lists || !read || interpreted.has(lists)) {
            if (!read) addUnresolved(1);
            break;
          }
          interpreted.add(lists);
          const child: Scope = {
            vars: new Map(scope.vars),
            sourceDir: absoluteOf(directory!),
            binaryDir: path.join(BUILD_MARKER, directory!),
            dirIncludes: [...scope.dirIncludes],
            dirDefinitions: [...scope.dirDefinitions],
            targets: [],
            isRoot: false,
          };
          run(read.commands, child, lists, depth + 1);
          break;
        }
        case "include_directories": {
          const dirs = items(command, 0, scope);
          addUnresolved(dirs.unresolved);
          addDirectoryIncludes(scope, dirs.values.filter((value) => !["AFTER", "BEFORE", "SYSTEM"].includes(value)).flatMap((value) => {
            const dir = relative(toAbsolute(value, scope));
            return dir === null ? [] : [dir];
          }));
          break;
        }
        case "add_definitions":
        case "add_compile_definitions": {
          const definitions = items(command, 0, scope, false);
          addUnresolved(definitions.unresolved);
          const list = definitions.values.flatMap((value) => command.name === "add_definitions" ? (value.startsWith("-D") ? [value.slice(2)] : []) : [value.replace(/^-D/u, "")]);
          for (const definition of list) {
            addUnique(scope.dirDefinitions, definition);
            for (const target of scope.targets) addUnique(target.definitionsPrivate, definition);
          }
          break;
        }
        case "add_executable":
        case "add_library": {
          const name = command.args[0] ? substitute(command.args[0].text, scope) : null;
          if (!name || name.value === "" || name.opaque) {
            addUnresolved(1);
            break;
          }
          const keywords = command.name === "add_executable" ? EXECUTABLE_KEYWORDS : LIBRARY_KEYWORDS;
          const rest = items(command, 1, scope);
          if (command.args[1]?.text === "ALIAS") {
            const aliased = command.args[2] ? substitute(command.args[2].text, scope).value : "";
            if (aliased !== "") aliases.set(name.value, aliased);
            break;
          }
          if (rest.values.includes("IMPORTED")) break;
          let type: TargetType = command.name === "add_executable" ? "executable" : "library";
          for (const keyword of rest.values) {
            if (keyword === "STATIC") type = "static";
            else if (keyword === "SHARED") type = "shared";
            else if (keyword === "MODULE") type = "module";
            else if (keyword === "OBJECT") type = "object";
            else if (keyword === "INTERFACE") type = "interface";
          }
          const target = newTarget(name.value, type, file, command.line, scope);
          defineTarget(target, scope);
          // Another command may have created it first: only the creator reads sources.
          if (targets.get(name.value) !== target) break;
          addUnresolved(rest.unresolved, target);
          addSources(target, rest.values.filter((value) => !keywords.has(value)), scope);
          break;
        }
        case "target_sources": {
          const target = command.args[0] ? resolveTarget(substitute(command.args[0].text, scope).value) : undefined;
          if (!target) break;
          const rest = items(command, 1, scope);
          addUnresolved(rest.unresolved, target);
          addSources(target, rest.values.filter((value) => !VISIBILITY.has(value) && value !== "FILE_SET"), scope);
          break;
        }
        case "target_include_directories": {
          const target = command.args[0] ? resolveTarget(substitute(command.args[0].text, scope).value) : undefined;
          if (!target) break;
          const rest = items(command, 1, scope);
          addUnresolved(rest.unresolved, target);
          let visibility = "PRIVATE";
          for (const value of rest.values) {
            if (VISIBILITY.has(value)) visibility = value;
            else if (value === "SYSTEM" || value === "BEFORE" || value === "AFTER") continue;
            else {
              const dir = relative(toAbsolute(value, scope));
              if (dir === null) continue;
              if (visibility !== "INTERFACE") addUnique(target.includePrivate, dir);
              if (visibility !== "PRIVATE") addUnique(target.includeInterface, dir);
            }
          }
          break;
        }
        case "target_compile_definitions": {
          const target = command.args[0] ? resolveTarget(substitute(command.args[0].text, scope).value) : undefined;
          if (!target) break;
          const rest = items(command, 1, scope, false);
          addUnresolved(rest.unresolved, target);
          let visibility = "PRIVATE";
          for (const value of rest.values) {
            if (VISIBILITY.has(value)) {
              visibility = value;
              continue;
            }
            const definition = value.replace(/^-D/u, "");
            if (visibility !== "INTERFACE") addUnique(target.definitionsPrivate, definition);
            if (visibility !== "PRIVATE") addUnique(target.definitionsInterface, definition);
          }
          break;
        }
        case "target_link_libraries": {
          const target = command.args[0] ? resolveTarget(substitute(command.args[0].text, scope).value) : undefined;
          if (!target) break;
          const rest = items(command, 1, scope);
          addUnresolved(rest.unresolved, target);
          let visibility: "public" | "private" | "interface" = "public";
          for (const value of rest.values) {
            if (VISIBILITY.has(value)) {
              visibility = value.toLowerCase() as typeof visibility;
              continue;
            }
            if (value === "LINK_PUBLIC") visibility = "public";
            else if (value === "LINK_PRIVATE") visibility = "private";
            else if (value === "debug" || value === "optimized" || value === "general") continue;
            else {
              const linked = resolveTarget(value);
              // A name that is not (yet) a target is a system library or one the
              // scan does not see: `m`, `Threads::Threads`, `-lfoo`. A later
              // target of that name is matched when the model is finished.
              target.links.push({ target: `cmake:${linked ? linked.name : value}`, visibility });
            }
          }
          break;
        }
        default:
          break;
      }
    }
  };

  const addDirectoryIncludes = (scope: Scope, dirs: string[]): void => {
    for (const dir of dirs) {
      addUnique(scope.dirIncludes, dir);
      for (const target of scope.targets) addUnique(target.includePrivate, dir);
    }
  };

  const rootFiles = [...reads.keys()]
    .filter((file) => path.posix.basename(file) === "CMakeLists.txt" && !subdirectories.has(directoryOf(file)))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  for (const file of rootFiles) {
    if (interpreted.has(file)) continue;
    interpreted.add(file);
    const dir = directoryOf(file);
    const scope: Scope = {
      vars: new Map(),
      sourceDir: absoluteOf(dir),
      binaryDir: path.join(BUILD_MARKER, dir),
      dirIncludes: [],
      dirDefinitions: [],
      targets: [],
      isRoot: true,
    };
    run(reads.get(file)!.commands, scope, file, 0);
  }

  // A link to a name that became a target later is a link between targets.
  const known = new Set([...targets.keys()]);
  const result = [...targets.values()];
  for (const target of result) {
    target.links = target.links
      .map((link) => ({ ...link, target: `cmake:${aliases.get(link.target.slice("cmake:".length)) ?? link.target.slice("cmake:".length)}` }))
      .filter((link) => known.has(link.target.slice("cmake:".length)) && link.target !== `cmake:${target.name}`);
  }
  return { targets: result, files: [...interpreted].sort(), unresolved, errors };
}

function newTarget(name: string, type: TargetType, file: string, line: number, scope: Scope): BuildTarget {
  void scope;
  return {
    system: "cmake",
    name,
    type,
    dir: path.posix.dirname(file) === "." ? "" : path.posix.dirname(file),
    file,
    line,
    sources: [],
    links: [],
    includePrivate: [],
    includeInterface: [],
    definitionsPrivate: [],
    definitionsInterface: [],
    unresolved: 0,
  };
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

// A file name or path glob (`*`, `?`, `[abc]`) as a regular expression.
function globRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[") {
      const end = pattern.indexOf("]", index);
      if (end === -1) source += "\\[";
      else {
        source += pattern.slice(index, end + 1);
        index = end;
      }
    } else source += char.replace(/[.+^${}()|\\]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}
