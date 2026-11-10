// Reads a shell or PowerShell script (or the text of a Dockerfile `RUN`, a
// Makefile recipe, an npm script) for the environment it reads and sets and
// the commands it runs. It is a line reader, not a shell: it does not expand
// functions, aliases or `eval`.

export type ScriptEnvRead = { name: string; line: number; access: string };
export type ScriptEnvDecl = { name: string; line: number };
export type ScriptCommand = { text: string; line: number };

export type ScriptScan = {
  reads: ScriptEnvRead[];
  declarations: ScriptEnvDecl[];
  commands: ScriptCommand[];
};

// Names the shell itself sets or every environment has: not the project's env.
const AMBIENT = new Set([
  "PATH", "HOME", "PWD", "OLDPWD", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "HOSTNAME", "LANG", "LC_ALL",
  "IFS", "RANDOM", "SECONDS", "LINENO", "REPLY", "UID", "EUID", "PPID", "SHLVL", "OPTARG", "OPTIND", "OPTERR",
  "FUNCNAME", "PIPESTATUS", "MACHTYPE", "OSTYPE", "HOSTTYPE", "PS1", "PS2", "PS4", "CDPATH", "MAIL", "TZ",
]);

// Environment variables are upper case by convention; `$name` is nearly always
// a local, a loop variable or an argument.
export function isEnvName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/u.test(name) && !AMBIENT.has(name) && !name.startsWith("BASH_") && !name.startsWith("BASH");
}

type Logical = { text: string; line: number };

// Logical lines: `\` continuations joined, comments and single-quoted text
// removed, quoted heredoc bodies dropped (unquoted bodies are kept: they expand).
function logicalLines(source: string): Logical[] {
  const raw = source.split(/\r?\n/u);
  const lines: Logical[] = [];
  let heredoc: { delimiter: string; quoted: boolean; dash: boolean } | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    let text = raw[index]!;
    const line = index + 1;
    if (heredoc) {
      const check = heredoc.dash ? text.replace(/^\t+/u, "") : text;
      if (check === heredoc.delimiter) {
        heredoc = null;
        continue;
      }
      if (!heredoc.quoted) lines.push({ text: stripComment(text, false), line });
      continue;
    }
    const start = line;
    while (/\\\s*$/u.test(text) && index + 1 < raw.length) {
      text = `${text.replace(/\\\s*$/u, "")} ${raw[index + 1]!.trim()}`;
      index += 1;
    }
    const cleaned = stripComment(text, true);
    // Looked for in the raw line: single-quoted text is blanked in `cleaned`.
    const opened = /(?<!<)<<(?!<)(-?)\s*(["']?)([A-Za-z_][\w-]*)\2/u.exec(text);
    if (opened) heredoc = { delimiter: opened[3]!, quoted: opened[2] !== "", dash: opened[1] === "-" };
    lines.push({ text: cleaned, line: start });
  }
  return lines;
}

// Removes a trailing `# comment` (a `#` that starts a word, outside quotes) and,
// when `singles`, the contents of single-quoted strings (no expansion there).
function stripComment(text: string, singles: boolean): string {
  let out = "";
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\" && quote === '"') {
        out += char + (text[index + 1] ?? "");
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      out += quote === "'" && singles ? " " : char;
      continue;
    }
    if (char === "\\") {
      out += char + (text[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s|[;&|(]/u.test(text[index - 1]!))) break;
    out += char;
  }
  return out;
}

const ASSIGNMENT = /(?:^|[\s;&|(])(export\s+|local\s+|declare\s+(?:-[a-zA-Z]+\s+)?|typeset\s+|readonly\s+)?([A-Za-z_]\w*)\+?=/gu;

export function scanShell(source: string): ScriptScan {
  return scanLines(logicalLines(source));
}

// Whether the value that starts at `start` (`NAME=value`) is followed by a
// command on the same line: `NAME=value node x.js`, not `NAME=value;`.
function startsCommand(text: string, start: number): boolean {
  let index = start;
  if (text[index] === '"' || text[index] === "'") {
    const end = text.indexOf(text[index]!, index + 1);
    index = end === -1 ? text.length : end + 1;
  } else {
    while (index < text.length && !/[\s;&|)]/u.test(text[index]!)) index += 1;
  }
  const rest = text.slice(index).trimStart();
  return rest !== "" && !/^[;&|)]/u.test(rest) && !/^[A-Za-z_]\w*\+?=/u.test(rest) || /^[A-Za-z_]\w*\+?=\S*\s+[^\s;&|)=]/u.test(rest);
}

function scanLines(lines: Logical[]): ScriptScan {
  const exported = new Set<string>();
  const locals = new Set<string>();
  const declarations: ScriptEnvDecl[] = [];
  const reads: ScriptEnvRead[] = [];
  const commands: ScriptCommand[] = [];

  // First pass: what the script assigns, exports and iterates over.
  for (const { text, line } of lines) {
    for (const match of text.matchAll(ASSIGNMENT)) {
      const name = match[2]!;
      const keyword = (match[1] ?? "").trim();
      const prefixOfCommand = keyword === "" && startsCommand(text, (match.index ?? 0) + match[0].length);
      if (keyword.startsWith("export") || (keyword.startsWith("declare") && /-\w*x/u.test(keyword))) {
        exported.add(name);
        if (isEnvName(name)) declarations.push({ name, line });
      } else if (prefixOfCommand && isEnvName(name)) {
        // `NAME=value command`: set for that command.
        declarations.push({ name, line });
      } else {
        locals.add(name);
      }
    }
    for (const match of text.matchAll(/\bexport\s+([A-Za-z_]\w*)(?![\w=])/gu)) {
      exported.add(match[1]!);
      if (isEnvName(match[1]!)) declarations.push({ name: match[1]!, line });
    }
    for (const match of text.matchAll(/\b(?:for|select)\s+([A-Za-z_]\w*)\s+in\b/gu)) locals.add(match[1]!);
    for (const match of text.matchAll(/\bread\s+((?:-\w+\s+)*)([A-Za-z_][\w\s]*)/gu)) {
      for (const name of match[2]!.split(/\s+/u)) if (/^[A-Za-z_]\w*$/u.test(name)) locals.add(name);
    }
    for (const match of text.matchAll(/\bgetopts\s+\S+\s+([A-Za-z_]\w*)/gu)) locals.add(match[1]!);
  }

  // Second pass: expansions of names that are not locals, and the commands.
  for (const { text, line } of lines) {
    for (const match of text.matchAll(/\$(?:\{#?!?([A-Za-z_]\w*)|([A-Za-z_]\w*))/gu)) {
      const name = match[1] ?? match[2]!;
      if (!isEnvName(name)) continue;
      if (locals.has(name) && !exported.has(name)) continue;
      reads.push({ name, line, access: match[1] ? `\${${name}}` : `$${name}` });
    }
    for (const command of splitCommands(text)) commands.push({ text: command, line });
  }
  return { reads: dedupe(reads), declarations: dedupe(declarations), commands };
}

// `a && b | c; d` → simple commands, outside quotes and `$(…)`.
export function splitCommands(text: string): string[] {
  const commands: string[] = [];
  let current = "";
  let quote: string | null = null;
  let depth = 0;
  const push = () => {
    const command = current.trim().replace(/^(?:then|do|else|elif|if|while|until|!)\s+/u, "").replace(/^\{\s*/u, "").trim();
    if (command !== "" && !/^(?:fi|done|esac|\}|\)|;;)$/u.test(command)) commands.push(command);
    current = "";
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\" && quote === '"') {
        current += char + (text[index + 1] ?? "");
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === "$" && text[index + 1] === "(") {
      depth += 1;
      current += "$(";
      index += 1;
    } else if (char === ")" && depth > 0) {
      depth -= 1;
      current += char;
    } else if (depth === 0 && (char === ";" || char === "|" || char === "&")) {
      if ((char === "|" || char === "&") && text[index + 1] === char) index += 1;
      else if (char === "&" && (text[index - 1] === ">" || text[index + 1] === ">")) {
        current += char;
        continue;
      }
      push();
    } else if (depth === 0 && char === "\n") {
      push();
    } else {
      current += char;
    }
  }
  push();
  return commands;
}

// PowerShell: `$env:NAME`, `${env:NAME}`, `[Environment]::GetEnvironmentVariable('NAME')`;
// `$env:NAME = …` and `SetEnvironmentVariable('NAME', …)` set it.
export function scanPowerShell(source: string): ScriptScan {
  const reads: ScriptEnvRead[] = [];
  const declarations: ScriptEnvDecl[] = [];
  const commands: ScriptCommand[] = [];
  let block = false;
  source.split(/\r?\n/u).forEach((raw, index) => {
    const line = index + 1;
    let text = raw;
    if (block) {
      const end = text.indexOf("#>");
      if (end === -1) return;
      block = false;
      text = text.slice(end + 2);
    }
    for (let open = text.indexOf("<#"); open !== -1; open = text.indexOf("<#")) {
      const end = text.indexOf("#>", open + 2);
      if (end === -1) {
        text = text.slice(0, open);
        block = true;
        break;
      }
      text = text.slice(0, open) + text.slice(end + 2);
    }
    text = stripPowerShellComment(text);
    for (const match of text.matchAll(/\$\{?env:([A-Za-z_]\w*)\}?(\s*(?:\+|\.)?=(?!=))?/giu)) {
      const name = match[1]!;
      if (!isEnvName(name.toUpperCase()) && !isEnvName(name)) continue;
      if (match[2]) declarations.push({ name, line });
      else reads.push({ name, line, access: `$env:${name}` });
    }
    for (const match of text.matchAll(/\[(?:System\.)?Environment\]::(Get|Set)EnvironmentVariable\(\s*["']([A-Za-z_]\w*)["']/giu)) {
      if (match[1]!.toLowerCase() === "set") declarations.push({ name: match[2]!, line });
      else reads.push({ name: match[2]!, line, access: "GetEnvironmentVariable" });
    }
    for (const command of splitPowerShellCommands(text)) commands.push({ text: command, line });
  });
  return { reads: dedupe(reads), declarations: dedupe(declarations), commands };
}

function stripPowerShellComment(text: string): string {
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "`") {
      index += 1;
    } else if (char === "#" && (index === 0 || /\s/u.test(text[index - 1]!))) {
      return text.slice(0, index);
    }
  }
  return text;
}

function splitPowerShellCommands(text: string): string[] {
  return text
    .split(/;|\|\||&&|\|/u)
    .map((part) => part.trim().replace(/^(?:&|\.)\s+(?=\S)/u, "").replace(/^\$\(|\)$/gu, "").trim())
    .filter((part) => part !== "" && !/^[{}]$/u.test(part));
}

function dedupe<T extends { name: string; line: number }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.name}:${item.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
