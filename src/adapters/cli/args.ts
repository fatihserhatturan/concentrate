import { parseArgs } from "node:util";

/**
 * Sub-command router on top of `node:util` parseArgs. Flags, help text, error
 * messages and exit codes follow the commander conventions the CLI used before.
 */

export type OptionSpec = {
  /** Commander-style flags, e.g. `-d, --database <path>`, `--continue-on-error`, `--no-retry-lock`. */
  flags: string;
  description: string;
  type?: "string" | "boolean" | "number";
  default?: unknown;
  multiple?: boolean;
};

export type ArgumentSpec = {
  name: string;
  description: string;
};

export type CommandSpec = {
  name: string;
  description: string;
  args?: ArgumentSpec[];
  options: OptionSpec[];
  action: (...args: any[]) => Promise<void>;
};

export type ProgramSpec = {
  name: string;
  description: string;
  version: string;
  commands: CommandSpec[];
};

export type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Help text wraps to this width, like commander does for non-TTY output. */
  columns?: number;
};

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

type ParsedFlag = {
  spec: OptionSpec;
  short?: string;
  long: string;
  /** parseArgs option name; `no-x` for negated flags. */
  name: string;
  /** Property name on the options object passed to the action. */
  key: string;
  negated: boolean;
  takesValue: boolean;
  term: string;
};

const HELP_FLAG: OptionSpec = { flags: "-h, --help", description: "display help for command" };
const VERSION_FLAG: OptionSpec = { flags: "-V, --version", description: "output the version number" };

class CliError extends Error {}

export async function runCli(program: ProgramSpec, argv: string[], io: CliIo = defaultIo): Promise<number> {
  try {
    return await dispatch(program, argv, io);
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

async function dispatch(program: ProgramSpec, argv: string[], io: CliIo): Promise<number> {
  const [first, ...rest] = argv;

  if (first === undefined) {
    io.stderr(programHelp(program, io));
    return 1;
  }
  if (first === "-h" || first === "--help") {
    io.stdout(programHelp(program, io));
    return 0;
  }
  if (first === "-V" || first === "--version") {
    io.stdout(`${program.version}\n`);
    return 0;
  }
  if (first === "help") {
    const target = rest[0] === undefined ? undefined : findCommand(program, rest[0]);
    io.stdout(target ? commandHelp(program, target, io) : programHelp(program, io));
    return 0;
  }
  if (first.startsWith("-")) {
    throw new CliError(`unknown option '${first}'`);
  }

  const command = findCommand(program, first);
  if (!command) {
    const suggestion = closestMatch(first, program.commands.map((candidate) => candidate.name));
    throw new CliError(`unknown command '${first}'${suggestion ? `. Did you mean '${suggestion}'?` : ""}`);
  }
  if (rest.includes("-h") || rest.includes("--help")) {
    io.stdout(commandHelp(program, command, io));
    return 0;
  }

  const { positionals, options } = parseCommandArgs(command, rest);
  await command.action(...positionals, options);
  return 0;
}

function findCommand(program: ProgramSpec, name: string): CommandSpec | undefined {
  return program.commands.find((command) => command.name === name);
}

export function parseCommandArgs(
  command: CommandSpec,
  argv: string[],
): { positionals: string[]; options: Record<string, unknown> } {
  const flags = command.options.map(parseFlag);
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    tokens: true,
    options: Object.fromEntries(flags.map((flag) => [flag.name, {
      type: flag.takesValue ? "string" : "boolean",
      ...(flag.short ? { short: flag.short } : {}),
      ...(flag.spec.multiple ? { multiple: true } : {}),
    } as const])),
  });

  const byName = new Map(flags.map((flag) => [flag.name, flag]));
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    const flag = byName.get(token.name);
    if (!flag) {
      const names = flags.flatMap((candidate) => [
        ...(candidate.short ? [`-${candidate.short}`] : []),
        `--${candidate.long}`,
      ]);
      // A one-letter short option is within one edit of every other short
      // option, so a suggestion for it would be a guess.
      const suggestion = /^-[^-]$/u.test(token.rawName) ? undefined : closestMatch(token.rawName, [...names, "-h", "--help"]);
      throw new CliError(`unknown option '${token.rawName}'${suggestion ? `. Did you mean '${suggestion}'?` : ""}`);
    }
    if (flag.takesValue && token.value === undefined) {
      throw new CliError(`option '${flag.term}' argument missing`);
    }
  }

  const options: Record<string, unknown> = {};
  for (const flag of flags) {
    const given = parsed.values[flag.name];
    if (flag.negated) {
      options[flag.key] = given === undefined;
    } else if (given === undefined) {
      const fallback = defaultValue(flag.spec);
      if (fallback !== undefined) options[flag.key] = fallback;
    } else if (flag.spec.type === "number") {
      options[flag.key] = Array.isArray(given)
        ? given.map((value) => toInteger(flag, value))
        : toInteger(flag, given);
    } else {
      options[flag.key] = given;
    }
  }

  const expected = command.args ?? [];
  const positionals = parsed.positionals;
  if (positionals.length < expected.length) {
    throw new CliError(`missing required argument '${expected[positionals.length]!.name}'`);
  }
  if (positionals.length > expected.length) {
    const noun = expected.length === 1 ? "argument" : "arguments";
    throw new CliError(`too many arguments for '${command.name}'. Expected ${expected.length} ${noun} but got ${positionals.length}.`);
  }

  return { positionals, options };
}

function closestMatch(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  let tied = false;
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
      tied = false;
    } else if (distance === bestDistance) {
      tied = true;
    }
  }
  return tied ? undefined : best;
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[right.length]!;
}

function toInteger(flag: ParsedFlag, value: unknown): number {
  if (typeof value !== "string" || !/^-?\d+$/.test(value.trim())) {
    throw new CliError(`option '${flag.term}' argument '${String(value)}' is invalid. Expected an integer.`);
  }
  return Number.parseInt(value, 10);
}

/** Commander semantics: booleans default to false and repeatable options to []. */
function defaultValue(spec: OptionSpec): unknown {
  return spec.default ?? (spec.multiple ? [] : spec.type === "boolean" ? false : undefined);
}

function parseFlag(spec: OptionSpec): ParsedFlag {
  const match = spec.flags.match(/^(?:-([A-Za-z]),\s*)?--([a-z][a-z0-9-]*)(?:\s+<[^>]+>)?$/);
  if (!match) {
    throw new Error(`Invalid option flags: ${spec.flags}`);
  }
  const [, short, long] = match as unknown as [string, string | undefined, string];
  const negated = long.startsWith("no-");
  const takesValue = spec.flags.includes("<");
  return {
    spec,
    ...(short ? { short } : {}),
    long,
    name: long,
    key: camelCase(negated ? long.slice(3) : long),
    negated,
    takesValue,
    term: spec.flags,
  };
}

function camelCase(value: string): string {
  return value.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

// --- Help -----------------------------------------------------------------

function programHelp(program: ProgramSpec, io: CliIo): string {
  const commandItems = [
    ...program.commands.map((command) => ({ term: commandTerm(command), description: command.description })),
    { term: "help [command]", description: "display help for command" },
  ];
  return renderHelp(io, `${program.name} [options] [command]`, program.description, [
    { title: "Options", items: [VERSION_FLAG, HELP_FLAG].map(optionItem) },
    { title: "Commands", items: commandItems },
  ]);
}

function commandHelp(program: ProgramSpec, command: CommandSpec, io: CliIo): string {
  const args = command.args ?? [];
  const usage = [program.name, command.name, "[options]", ...args.map((arg) => `<${arg.name}>`)].join(" ");
  return renderHelp(io, usage, command.description, [
    { title: "Arguments", items: args.map((arg) => ({ term: arg.name, description: arg.description })) },
    { title: "Options", items: [...command.options, HELP_FLAG].map(optionItem) },
  ]);
}

function commandTerm(command: CommandSpec): string {
  return [command.name, "[options]", ...(command.args ?? []).map((arg) => `<${arg.name}>`)].join(" ");
}

function optionItem(spec: OptionSpec): { term: string; description: string } {
  const value = spec.flags.startsWith("--no-") ? undefined : defaultValue(spec);
  return {
    term: spec.flags,
    description: value === undefined ? spec.description : `${spec.description} (default: ${JSON.stringify(value)})`,
  };
}

function renderHelp(
  io: CliIo,
  usage: string,
  description: string,
  sections: Array<{ title: string; items: Array<{ term: string; description: string }> }>,
): string {
  const visible = sections.filter((section) => section.items.length > 0);
  const termWidth = Math.max(...visible.flatMap((section) => section.items.map((item) => item.term.length)));
  const width = io.columns ?? 80;
  const descriptionWidth = width - termWidth - 4;
  const indent = " ".repeat(termWidth + 4);

  const lines = [`Usage: ${usage}`, "", description];
  for (const section of visible) {
    lines.push("", `${section.title}:`);
    for (const item of section.items) {
      const [head, ...tail] = wrap(item.description, descriptionWidth);
      lines.push(`  ${item.term.padEnd(termWidth)}  ${head ?? ""}`.trimEnd());
      lines.push(...tail.map((line) => `${indent}${line}`));
    }
  }
  return `${lines.join("\n")}\n`;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
