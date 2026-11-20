import path from "node:path";
import { emptyJavaBuildModel, javaModuleKey, type JavaBuildModel, type JavaModule } from "./types.js";

// Interprets the Gradle build files (`settings.gradle(.kts)`, `build.gradle(.kts)`) of a Java
// project. There is no Gradle grammar, so a small tokenizer (comments and strings are never code)
// and a statement/block splitter read both the Groovy and the Kotlin DSL.
//
// Read: `rootProject.name`, `include(...)`, `project(":x").projectDir = ...`, `plugins`/`apply`,
// `dependencies` (`project(":x")`, `project(path: ":x")`, `projects.x.y`), `sourceSets` (the
// `main`/`test` `java` source directories, in the nested, dotted and indexed forms), `application`
// and `springBoot` main classes, `version`, `group`, `sourceCompatibility`, `targetCompatibility`
// and `java.toolchain.languageVersion`.
//
// Choices:
//  * Conditions are not evaluated: every branch of an `if` is read.
//  * `srcDirs = ...` / `setSrcDirs(...)` replace the convention (`src/main/java`, `src/test/java`),
//    `srcDir`, `srcDirs(...)` and `srcDirs += ...` add to it. A replacement none of whose
//    values resolves is ignored (the convention stays).
//  * `subprojects { }` / `allprojects { }` (also `configure(subprojects) { }`) are applied to the
//    affected modules for their `sourceSets` only, and only when `sourceSets` is a direct child
//    (or under an `if`). Anything else in those blocks (dependencies, `plugins.withType { }`) is ignored.
//  * Child project directories default to `<settings dir>/<path with ":" as "/">`; a parent's
//    `projectDir` override does not move its children. Intermediate paths (`:a` of `include("a:b")`)
//    are modules too, as in Gradle.
//  * Several builds (settings files, or build files no settings file includes) are separate: the
//    shallowest keeps plain project paths, the others are prefixed with their directory
//    (`build-logic:conventions`, `:` becomes `build-logic`).
//  * Only `rootDir`, `settingsDir`, `projectDir` and `rootProject.projectDir` interpolate; any other
//    `$x` / `${x}` is counted in `unresolved`, as is a `buildDir` based path, a dependency on a
//    project that is not included and an included directory without files.

export type GradleInput = {
  files: ReadonlySet<string>;
  texts: ReadonlyMap<string, string>;
};

type Tok = { k: "id" | "str" | "num" | "sym" | "nl"; v: string; line: number; interp: boolean };
type Stmt = { tokens: Tok[]; block: Stmt[] | null; line: number };

const ESCAPED_DOLLAR = "\u0001";
const MAX_DEPTH = 60;

// ---- tokenizer ----

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  const push = (k: Tok["k"], v: string, tokLine: number, interp = false) => out.push({ k, v, line: tokLine, interp });
  const TWO = new Set(["+=", "-=", "?.", "->", "==", "!=", "&&", "||", "::", "<=", ">="]);
  while (i < n) {
    const c = text[i]!;
    if (c === "\n") { push("nl", "\n", line); line += 1; i += 1; continue; }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === " " || c === "﻿") { i += 1; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i += 1; continue; }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let j = i; j < stop; j += 1) if (text[j] === "\n") line += 1;
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const startLine = line;
      i += triple ? 3 : 1;
      let v = "";
      while (i < n) {
        const ch = text[i]!;
        if (ch === "\\" && i + 1 < n) {
          const nx = text[i + 1]!;
          v += nx === "$" ? ESCAPED_DOLLAR : nx;
          if (nx === "\n") line += 1;
          i += 2;
          continue;
        }
        if (triple ? text.startsWith(c.repeat(3), i) : ch === c) { i += triple ? 3 : 1; break; }
        if (!triple && ch === "\n") break;
        if (c === '"' && ch === "$" && text[i + 1] === "{") {
          let depth = 0;
          let j = i + 1;
          for (; j < n; j += 1) {
            const d = text[j]!;
            if (d === "{") depth += 1;
            else if (d === "}") { depth -= 1; if (depth === 0) break; }
            else if (d === "\n") { if (!triple) break; line += 1; }
          }
          const end = depth === 0 && text[j] === "}" ? j + 1 : j;
          v += text.slice(i, end);
          i = end;
          continue;
        }
        if (ch === "\n") line += 1;
        v += ch;
        i += 1;
      }
      push("str", v, startLine, c === '"');
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < n && text[j] !== "`" && text[j] !== "\n") j += 1;
      push("id", text.slice(i + 1, j), line);
      i = text[j] === "`" ? j + 1 : j;
      continue;
    }
    if (/[\p{L}_$]/u.test(c)) {
      let j = i + 1;
      while (j < n && /[\p{L}\p{N}_$]/u.test(text[j]!)) j += 1;
      push("id", text.slice(i, j), line);
      i = j;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i + 1;
      while (j < n && (/[\d_]/.test(text[j]!) || (text[j] === "." && /\d/.test(text[j + 1] ?? "")))) j += 1;
      push("num", text.slice(i, j), line);
      i = j;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO.has(two)) { push("sym", two, line); i += 2; continue; }
    push("sym", c, line);
    i += 1;
  }
  return out;
}

// ---- statements and blocks ----

const CONTINUES = new Set([",", ".", "+", "&&", "||", "?.", "="]);

function isSym(t: Tok | undefined, v: string): boolean {
  return t !== undefined && t.k === "sym" && t.v === v;
}

function isId(t: Tok | undefined, v?: string): boolean {
  return t !== undefined && t.k === "id" && (v === undefined || t.v === v);
}

function parseStatements(tokens: Tok[]): Stmt[] {
  type Frame = { stmts: Stmt[]; cur: Tok[]; head: Tok[]; paren: number };
  const root: Frame = { stmts: [], cur: [], head: [], paren: 0 };
  const stack: Frame[] = [root];
  const end = (f: Frame) => {
    if (f.cur.length > 0) f.stmts.push({ tokens: f.cur, block: null, line: f.cur[0]!.line });
    f.cur = [];
    f.paren = 0;
  };
  for (const t of tokens) {
    const f = stack[stack.length - 1]!;
    if (t.k === "nl") {
      if (f.paren > 0) continue;
      const last = f.cur[f.cur.length - 1];
      if (last !== undefined && last.k === "sym" && CONTINUES.has(last.v)) continue;
      end(f);
      continue;
    }
    if (t.k === "sym") {
      if (t.v === ";" && f.paren === 0) { end(f); continue; }
      if (t.v === "(" || t.v === "[") f.paren += 1;
      else if (t.v === ")" || t.v === "]") f.paren = Math.max(0, f.paren - 1);
      else if (t.v === "{" && f.paren === 0 && stack.length < MAX_DEPTH) {
        stack.push({ stmts: [], cur: [], head: f.cur, paren: 0 });
        f.cur = [];
        continue;
      } else if (t.v === "}" && f.paren === 0 && stack.length > 1) {
        end(f);
        stack.pop();
        const parent = stack[stack.length - 1]!;
        const head = f.head;
        parent.stmts.push({ tokens: head, block: f.stmts, line: head[0]?.line ?? t.line });
        continue;
      }
    }
    f.cur.push(t);
  }
  while (stack.length > 1) {
    const f = stack.pop()!;
    end(f);
    const parent = stack[stack.length - 1]!;
    parent.stmts.push({ tokens: f.head, block: f.stmts, line: f.head[0]?.line ?? 1 });
  }
  end(root);
  return root.stmts;
}

const NAMED = new Set(["named", "getByName", "create", "register", "maybeCreate", "getAt"]);
const TRANSPARENT = new Set(["if", "else", "try", "finally", "afterEvaluate"]);

// The leading dotted / indexed path of a statement: `sourceSets["main"].java.srcDirs`,
// `named("main")`, `val main by getting`; stops at a call's `(`.
function parseSegs(t: Tok[]): { segs: string[]; next: number } {
  const segs: string[] = [];
  let i = 0;
  if (isId(t[0], "val") && isId(t[1]) && isId(t[2], "by")) {
    return { segs: [t[1]!.v], next: Math.min(t.length, 4) };
  }
  for (;;) {
    const a = t[i];
    if (a === undefined) break;
    if (a.k === "str" && isSym(t[i + 1], "(")) { segs.push(a.v); i += 1; break; }
    if (a.k !== "id") break;
    if (NAMED.has(a.v) && isSym(t[i + 1], "(") && t[i + 2]?.k === "str" && isSym(t[i + 3], ")")) {
      segs.push(t[i + 2]!.v);
      i += 4;
    } else {
      segs.push(a.v);
      i += 1;
      if (isSym(t[i], "(")) break;
    }
    while (isSym(t[i], "[") && t[i + 1]?.k === "str" && isSym(t[i + 2], "]")) {
      segs.push(t[i + 1]!.v);
      i += 3;
    }
    if (isSym(t[i], ".") || isSym(t[i], "?.")) { i += 1; continue; }
    break;
  }
  return { segs, next: i };
}

type Visit = (segs: string[], rest: Tok[], stmt: Stmt) => boolean;

function walk(stmts: Stmt[], ctx: string[], visit: Visit, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  for (const s of stmts) {
    const { segs: head, next } = parseSegs(s.tokens);
    const rest = s.tokens.slice(next);
    if (head.length === 1 && TRANSPARENT.has(head[0]!)) {
      if (s.block) walk(s.block, ctx, visit, depth + 1);
      continue;
    }
    const segs = [...ctx, ...head];
    const descend = visit(segs, rest, s);
    if (s.block && descend) walk(s.block, rest.length > 0 ? [...segs, "()"] : segs, visit, depth + 1);
  }
}

// ---- values ----

function hasInterp(t: Tok): boolean {
  return t.interp && t.v.includes("$");
}

function unescape(v: string): string {
  return v.split(ESCAPED_DOLLAR).join("$");
}

function literal(rest: Tok[]): { value: string | null; interp: boolean } | null {
  for (const t of rest) {
    if (t.k === "str") return hasInterp(t) ? { value: null, interp: true } : { value: unescape(t.v), interp: false };
    if (t.k === "num") return { value: t.v, interp: false };
    if (t.k === "id") {
      const m = /^VERSION_(\d+(?:_\d+)*)$/.exec(t.v);
      if (m) return { value: m[1]!.replace(/_/g, "."), interp: false };
    }
  }
  return null;
}

function normalizeRel(p: string): string | null {
  const n = path.posix.normalize(p).replace(/\/+$/u, "");
  if (n === "" || n === ".") return ".";
  if (n === ".." || n.startsWith("../") || n.startsWith("/")) return null;
  return n;
}

type Dirs = { moduleDir: string; rootDir: string };

// A string that names a file or directory, relative to the scan root; null when it cannot be known.
function resolveFs(tok: Tok, base: string, dirs: Dirs): string | null {
  let s = tok.v;
  let anchor = base;
  if (hasInterp(tok)) {
    const m = /^\$(?:\{([\w.]+)\}|([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*))/u.exec(s);
    if (!m) return null;
    const name = m[1] ?? m[2]!;
    const known: Record<string, string> = {
      rootDir: dirs.rootDir,
      settingsDir: dirs.rootDir,
      "rootProject.projectDir": dirs.rootDir,
      "rootProject.rootDir": dirs.rootDir,
      "project.rootDir": dirs.rootDir,
      projectDir: dirs.moduleDir,
      "project.projectDir": dirs.moduleDir,
    };
    const dir = known[name];
    if (dir === undefined) return null;
    s = s.slice(m[0].length).replace(/^\/+/u, "");
    if (s.includes("$")) return null;
    anchor = dir;
  } else if (s.startsWith("/")) {
    return null;
  }
  return normalizeRel(path.posix.join(anchor, unescape(s)));
}

function resolvePaths(rest: Tok[], dirs: Dirs): { paths: string[]; unresolved: number } {
  if (rest.some((t) => isId(t, "buildDir") || isId(t, "buildDirectory"))) return { paths: [], unresolved: 1 };
  const paths: string[] = [];
  let unresolved = 0;
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i]!;
    if (t.k !== "str") continue;
    let base = dirs.moduleDir;
    if (isSym(rest[i - 1], ",") && isId(rest[i - 2])) {
      const name = rest[i - 2]!.v;
      if (name === "rootDir" || name === "settingsDir") base = dirs.rootDir;
      else if (name === "projectDir") base = isId(rest[i - 4], "rootProject") ? dirs.rootDir : dirs.moduleDir;
    }
    const r = resolveFs(t, base, dirs);
    if (r === null) unresolved += 1;
    else if (!paths.includes(r)) paths.push(r);
  }
  return { paths, unresolved };
}

// ---- settings ----

type Include = { segs: string[]; line: number };
type SettingsRead = {
  rootName: string | null;
  includes: Include[];
  overrides: Map<string, string>;
  unresolved: number;
};

const SETTINGS_SKIP = new Set(["pluginManagement", "dependencyResolutionManagement", "buildscript", "plugins"]);

function projectSegs(raw: string): string[] {
  return raw.split(":").map((s) => s.trim()).filter((s) => s !== "");
}

function projectPath(segs: string[]): string {
  return segs.length === 0 ? ":" : `:${segs.join(":")}`;
}

function readSettings(stmts: Stmt[], settingsDir: string): SettingsRead {
  const result: SettingsRead = { rootName: null, includes: [], overrides: new Map(), unresolved: 0 };
  const dirs: Dirs = { moduleDir: settingsDir, rootDir: settingsDir };
  const visit = (list: Stmt[], depth: number): void => {
    if (depth > MAX_DEPTH) return;
    for (const s of list) {
      const t = s.tokens;
      const f = t[0];
      if (isId(f, "include") && t.length > 1) {
        const strs = t.slice(1).filter((x) => x.k === "str");
        if (strs.length === 0) result.unresolved += 1;
        for (const str of strs) {
          if (hasInterp(str)) { result.unresolved += 1; continue; }
          const segs = projectSegs(unescape(str.v));
          if (segs.length > 0) result.includes.push({ segs, line: str.line });
        }
      } else if (isId(f, "rootProject") && isSym(t[1], ".") && isId(t[2], "name") && isSym(t[3], "=")) {
        const lit = literal(t.slice(4));
        if (lit?.value != null) result.rootName = lit.value;
        else if (lit?.interp) result.unresolved += 1;
      } else if ((isId(f, "project") || isId(f, "findProject")) && isSym(t[1], "(") && t[2]?.k === "str" && isSym(t[3], ")")) {
        const dot = isSym(t[4], ".") || isSym(t[4], "?.");
        let rest: Tok[] | null = null;
        if (dot && isId(t[5], "projectDir") && isSym(t[6], "=")) rest = t.slice(7);
        else if (dot && isId(t[5], "setProjectDir") && isSym(t[6], "(")) rest = t.slice(7);
        if (rest !== null && !hasInterp(t[2]!)) {
          const { paths, unresolved } = resolvePaths(rest, dirs);
          result.unresolved += unresolved;
          if (paths[0] !== undefined) result.overrides.set(projectPath(projectSegs(unescape(t[2]!.v))), paths[0]);
        }
      }
      if (s.block && !(f && f.k === "id" && SETTINGS_SKIP.has(f.v))) visit(s.block, depth + 1);
    }
  };
  visit(stmts, 0);
  return result;
}

// ---- build files ----

type RawOp = { set: string; replace: boolean; rest: Tok[]; line: number };
type RawDep =
  | { conf: string; kind: "path"; path: string }
  | { conf: string; kind: "accessor"; chain: string[] }
  | { conf: string; kind: "bad" };
type Shared = { kind: "all" | "sub"; stmts: Stmt[] };

type BuildInfo = {
  version: string | null;
  config: Map<string, string>;
  plugins: Set<string>;
  hasSourceSets: boolean;
  hasApplication: boolean;
  ops: RawOp[];
  shared: Shared[];
  deps: RawDep[];
  appMain: string | null;
  bootMain: string | null;
  unresolved: number;
};

const JAVA_PLUGINS = new Set([
  "java", "java-library", "application", "war", "groovy", "scala", "org.springframework.boot",
  "org.jetbrains.kotlin.jvm", "com.android.application", "com.android.library",
]);
const KNOWN_TOP = new Set(["sourceSets", "dependencies", "java", "application", "springBoot", "plugins"]);

function emptyInfo(): BuildInfo {
  return {
    version: null, config: new Map(), plugins: new Set(), hasSourceSets: false, hasApplication: false,
    ops: [], shared: [], deps: [], appMain: null, bootMain: null, unresolved: 0,
  };
}

function sourceOp(segs: string[], rest: Tok[], s: Stmt): RawOp | null {
  const idx = segs.indexOf("sourceSets");
  if (idx < 0 || s.block) return null;
  if (segs.length !== idx + 4 || segs[idx + 2] !== "java") return null;
  const name = segs[idx + 3]!;
  if (name !== "srcDirs" && name !== "srcDir" && name !== "setSrcDirs") return null;
  const replace = name === "setSrcDirs" || (name === "srcDirs" && isSym(rest[0], "="));
  return { set: segs[idx + 1]!, replace, rest, line: s.line };
}

function projectRefs(conf: string, rest: Tok[]): RawDep[] {
  const out: RawDep[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i]!;
    if (isId(t, "project") && isSym(rest[i + 1], "(") && !isSym(rest[i - 1], ".")) {
      const a = rest[i + 2];
      let str: Tok | undefined;
      if (a?.k === "str") str = a;
      else if (isId(a, "path") && (isSym(rest[i + 3], ":") || isSym(rest[i + 3], "=")) && rest[i + 4]?.k === "str") str = rest[i + 4];
      if (str === undefined || hasInterp(str)) out.push({ conf, kind: "bad" });
      else out.push({ conf, kind: "path", path: projectPath(projectSegs(unescape(str.v))) });
    } else if (isId(t, "projects") && isSym(rest[i + 1], ".") && !isSym(rest[i - 1], ".")) {
      const chain: string[] = [];
      let j = i + 1;
      while (isSym(rest[j], ".") && isId(rest[j + 1])) { chain.push(rest[j + 1]!.v); j += 2; }
      out.push({ conf, kind: "accessor", chain });
      i = j - 1;
    }
  }
  return out;
}

function analyze(stmts: Stmt[]): BuildInfo {
  const info = emptyInfo();
  const visit: Visit = (segs, rest, s) => {
    const top = segs[0];
    if (top === undefined) return false;
    if (segs.length === 1 && s.block && (top === "subprojects" || top === "allprojects")) {
      info.shared.push({ kind: top === "subprojects" ? "sub" : "all", stmts: s.block });
      return false;
    }
    if (segs.length === 1 && top === "configure" && s.block) {
      if (rest.some((t) => isId(t, "subprojects"))) info.shared.push({ kind: "sub", stmts: s.block });
      else if (rest.some((t) => isId(t, "allprojects"))) info.shared.push({ kind: "all", stmts: s.block });
      return false;
    }
    if (top === "plugins" && !s.block && segs.length >= 2) {
      const name = segs[1]!;
      if (name === "id") {
        const lit = literal(rest);
        if (lit?.value) info.plugins.add(lit.value);
      } else if (name === "kotlin") {
        if (literal(rest)?.value === "jvm") info.plugins.add("org.jetbrains.kotlin.jvm");
      } else if (segs.length === 2) {
        info.plugins.add(name);
      }
      return false;
    }
    if (top === "apply" && segs.length === 1 && !s.block) {
      for (let i = 0; i < rest.length; i += 1) {
        if (isId(rest[i], "plugin") && (isSym(rest[i + 1], ":") || isSym(rest[i + 1], "=")) && rest[i + 2]?.k === "str") {
          info.plugins.add(unescape(rest[i + 2]!.v));
        }
      }
      return false;
    }
    if (segs.includes("sourceSets")) {
      info.hasSourceSets = true;
      const op = sourceOp(segs, rest, s);
      if (op !== null) info.ops.push(op);
      return true;
    }
    if (top === "application") {
      info.hasApplication = true;
      if (!s.block && (segs.includes("mainClass") || segs.includes("mainClassName"))) setMain(info, "app", rest);
      return true;
    }
    if (top === "mainClassName" && segs.length === 1 && !s.block) {
      setMain(info, "app", rest);
      return false;
    }
    if (top === "springBoot") {
      if (!s.block && segs.includes("mainClass")) setMain(info, "boot", rest);
      return true;
    }
    if (top === "dependencies") {
      if (segs.length >= 2 && segs[1] !== "()") info.deps.push(...projectRefs(segs[1]!, rest));
      return segs.length === 1;
    }
    if (segs.length === 1 && (top === "version" || top === "group") && !s.block) {
      const lit = literal(rest);
      if (lit?.interp) info.unresolved += 1;
      else if (lit?.value != null) {
        if (top === "version") info.version = lit.value;
        else info.config.set("group", lit.value);
      }
      return false;
    }
    const last = segs[segs.length - 1]!;
    if ((last === "sourceCompatibility" || last === "targetCompatibility") && (segs.length === 1 || top === "java") && !s.block) {
      const lit = literal(rest);
      if (lit?.interp) info.unresolved += 1;
      else if (lit?.value != null) info.config.set(last, lit.value);
      return false;
    }
    if (top === "java" && segs.includes("toolchain") && segs.includes("languageVersion") && !s.block) {
      const lit = literal(rest);
      if (lit?.value != null) info.config.set("java.toolchain.languageVersion", lit.value);
      return false;
    }
    return KNOWN_TOP.has(top);
  };
  walk(stmts, [], visit);
  return info;
}

function setMain(info: BuildInfo, kind: "app" | "boot", rest: Tok[]): void {
  const str = rest.find((t) => t.k === "str");
  if (str === undefined || hasInterp(str)) { info.unresolved += 1; return; }
  const value = unescape(str.v);
  if (kind === "app") info.appMain = value;
  else info.bootMain = value;
}

// `sourceSets` of a `subprojects` / `allprojects` block, nothing else.
function sharedOps(stmts: Stmt[]): RawOp[] {
  const ops: RawOp[] = [];
  walk(stmts, [], (segs, rest, s) => {
    if (segs[0] !== "sourceSets") return false;
    const op = sourceOp(segs, rest, s);
    if (op !== null) ops.push(op);
    return true;
  });
  return ops;
}

// ---- builds ----

type Project = {
  segs: string[];
  path: string;
  dir: string;
  line: number;
  exists: boolean;
  buildFile: string | null;
  unresolved: number;
};

type Build = {
  dir: string;
  settingsFile: string | null;
  rootName: string | null;
  projects: Project[];
  prefix: string;
};

function camel(name: string): string {
  const parts = name.split(/[-_.]/u).filter((p) => p !== "");
  return parts.map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1))).join("");
}

function moduleName(build: Build, projectPathValue: string): string {
  if (build.prefix === "") return projectPathValue;
  return projectPathValue === ":" ? build.prefix : build.prefix + projectPathValue;
}

function depthOf(dir: string): number {
  return dir === "." ? 0 : dir.split("/").length;
}

function isPrefixPath(a: string[], b: string[]): boolean {
  return a.length <= b.length && a.every((s, i) => s === b[i]);
}

export function interpretGradle(input: GradleInput): JavaBuildModel {
  try {
    return interpret(input);
  } catch {
    return emptyJavaBuildModel();
  }
}

function interpret(input: GradleInput): JavaBuildModel {
  const texts = input.texts;
  const keys = [...texts.keys()].sort();
  const cache = new Map<string, Stmt[]>();
  const stmtsOf = (file: string): Stmt[] => {
    let s = cache.get(file);
    if (s === undefined) {
      try {
        s = parseStatements(tokenize(texts.get(file) ?? ""));
      } catch {
        s = [];
      }
      cache.set(file, s);
    }
    return s;
  };

  const baseOf = (file: string) => file.slice(file.lastIndexOf("/") + 1);
  const dirOf = (file: string) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".");
  const join = (dir: string, name: string) => (dir === "." ? name : `${dir}/${name}`);

  const settingsByDir = new Map<string, string>();
  const buildByDir = new Map<string, string>();
  for (const key of keys) {
    const b = baseOf(key);
    if ((b === "settings.gradle" || b === "settings.gradle.kts") && !settingsByDir.has(dirOf(key))) settingsByDir.set(dirOf(key), key);
    if ((b === "build.gradle" || b === "build.gradle.kts") && !buildByDir.has(dirOf(key))) buildByDir.set(dirOf(key), key);
  }

  const dirsWithFiles = new Set<string>(["."]);
  for (const f of [...input.files, ...keys]) {
    let d = dirOf(f);
    while (d !== "." && !dirsWithFiles.has(d)) {
      dirsWithFiles.add(d);
      d = dirOf(d);
    }
  }

  const builds: Build[] = [];
  const claimedDirs = new Set<string>();
  const reads = new Map<Build, SettingsRead>();

  for (const [dir, settingsFile] of settingsByDir) {
    const read = readSettings(stmtsOf(settingsFile), dir);
    const build: Build = { dir, settingsFile, rootName: read.rootName, projects: [], prefix: "" };
    const make = (segs: string[], line: number): Project => {
      const p = projectPath(segs);
      const pdir = read.overrides.get(p) ?? (segs.length === 0 ? dir : normalizeRel(path.posix.join(dir, ...segs)) ?? dir);
      return { segs, path: p, dir: pdir, line, exists: dirsWithFiles.has(pdir), buildFile: buildByDir.get(pdir) ?? null, unresolved: 0 };
    };
    const byPath = new Map<string, Project>();
    const root = make([], 1);
    build.projects.push(root);
    byPath.set(root.path, root);
    root.unresolved += read.unresolved;
    for (const inc of read.includes) {
      for (let k = 1; k <= inc.segs.length; k += 1) {
        const segs = inc.segs.slice(0, k);
        const p = projectPath(segs);
        if (byPath.has(p)) continue;
        const project = make(segs, inc.line);
        byPath.set(p, project);
        build.projects.push(project);
        if (!project.exists) project.unresolved += 1;
      }
    }
    for (const p of build.projects) if (p.buildFile !== null) claimedDirs.add(p.dir);
    reads.set(build, read);
    builds.push(build);
  }

  for (const [dir] of buildByDir) {
    if (claimedDirs.has(dir)) continue;
    const root: Project = { segs: [], path: ":", dir, line: 1, exists: true, buildFile: buildByDir.get(dir) ?? null, unresolved: 0 };
    builds.push({ dir, settingsFile: null, rootName: null, projects: [root], prefix: "" });
  }

  builds.sort((a, b) => depthOf(a.dir) - depthOf(b.dir) || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  builds.forEach((b, i) => { b.prefix = i === 0 ? "" : b.dir.replace(/\//gu, ":"); });

  const modules: JavaModule[] = [];
  const files = new Set<string>();

  for (const build of builds) {
    if (build.settingsFile !== null) files.add(build.settingsFile);
    const infos = new Map<Project, BuildInfo>();
    for (const p of build.projects) {
      if (p.buildFile !== null) files.add(p.buildFile);
      infos.set(p, p.buildFile !== null ? analyze(stmtsOf(p.buildFile)) : emptyInfo());
    }
    const byPath = new Map(build.projects.map((p) => [p.path, p] as const));
    const accessors = new Map<string, string>();
    for (const p of build.projects) {
      if (p.segs.length > 0) accessors.set(p.segs.map(camel).join("."), p.path);
    }
    if (build.rootName !== null) accessors.set(camel(build.rootName), ":");

    for (const p of build.projects) {
      const info = infos.get(p)!;
      const dirs: Dirs = { moduleDir: p.dir, rootDir: build.dir };
      let unresolved = p.unresolved + info.unresolved;

      // Source set operations: the ancestors' shared blocks first, then the module's own.
      const ops: RawOp[] = [];
      for (const anc of build.projects) {
        if (!isPrefixPath(anc.segs, p.segs)) continue;
        const own = anc === p;
        for (const shared of infos.get(anc)!.shared) {
          if (shared.kind === "sub" && own) continue;
          ops.push(...sharedOps(shared.stmts));
        }
      }
      const sharedCount = ops.length;
      ops.push(...info.ops);

      const roots: Record<string, string[]> = {
        main: [join(p.dir, "src/main/java")],
        test: [join(p.dir, "src/test/java")],
      };
      for (const op of ops) {
        if (op.set !== "main" && op.set !== "test") continue;
        const { paths, unresolved: u } = resolvePaths(op.rest, dirs);
        unresolved += u;
        if (op.replace) {
          if (paths.length > 0) roots[op.set] = paths;
        } else {
          for (const x of paths) if (!roots[op.set]!.includes(x)) roots[op.set]!.push(x);
        }
      }

      const dependencies: JavaModule["dependencies"] = [];
      for (const dep of info.deps) {
        let target: string | null = null;
        if (dep.kind === "path") target = byPath.has(dep.path) ? dep.path : null;
        else if (dep.kind === "accessor") {
          for (let len = dep.chain.length; len >= 1 && target === null; len -= 1) {
            target = accessors.get(dep.chain.slice(0, len).join(".")) ?? null;
          }
        }
        if (target === null) { unresolved += 1; continue; }
        if (target === p.path) continue;
        const key = javaModuleKey({ system: "gradle", name: moduleName(build, target) });
        if (!dependencies.some((d) => d.module === key && d.scope === dep.conf)) dependencies.push({ module: key, scope: dep.conf });
      }

      const javaConfig = info.hasSourceSets || info.hasApplication || sharedCount > 0 || [...info.plugins].some((x) => JAVA_PLUGINS.has(x));
      const config = new Map<string, string>();
      const readRoot = reads.get(build);
      if (p.path === ":" && readRoot?.rootName != null) config.set("rootProject.name", readRoot.rootName);
      for (const [k, v] of info.config) config.set(k, v);

      const mainClass = info.appMain ?? info.bootMain;
      modules.push({
        system: "gradle",
        name: moduleName(build, p.path),
        dir: p.dir,
        file: p.buildFile ?? build.settingsFile ?? "",
        line: p.buildFile !== null ? 1 : p.line,
        version: info.version,
        aggregator: p.path === ":" && build.projects.length > 1 && !javaConfig,
        parent: null,
        sourceRoots: roots.main!,
        testSourceRoots: roots.test!,
        dependencies,
        mainClass,
        mainClassSource: info.appMain !== null ? "application" : info.bootMain !== null ? "spring-boot" : null,
        config: [...config].map(([key, value]) => ({ key, value })),
        unresolved,
      });
    }
  }

  return { modules, files: [...files].sort(), unresolved: modules.reduce((n, m) => n + m.unresolved, 0) };
}
