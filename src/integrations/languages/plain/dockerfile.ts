// A small Dockerfile reader (there is no usable tree-sitter grammar on npm:
// `tree-sitter-dockerfile` there is a security placeholder). It splits a file
// into instructions, joining line continuations and skipping comments and
// heredoc bodies, and reports lines that start no known instruction.

export type DockerInstruction = {
  instruction: string;
  args: string;
  line: number;
  endLine: number;
};

export type DockerfileRead = {
  instructions: DockerInstruction[];
  errors: Array<{ line: number; message: string }>;
};

const INSTRUCTIONS = new Set([
  "FROM", "RUN", "CMD", "LABEL", "MAINTAINER", "EXPOSE", "ENV", "ADD", "COPY", "ENTRYPOINT",
  "VOLUME", "USER", "WORKDIR", "ARG", "ONBUILD", "STOPSIGNAL", "HEALTHCHECK", "SHELL",
]);

export function readDockerfile(source: string): DockerfileRead {
  const lines = source.split(/\r?\n/u);
  const instructions: DockerInstruction[] = [];
  const errors: DockerfileRead["errors"] = [];

  // `# escape=\`` on the first lines changes the continuation character.
  let escape = "\\";
  for (const line of lines) {
    const directive = /^\s*#\s*([a-z]+)\s*=\s*(\S+)\s*$/iu.exec(line);
    if (!directive) break;
    if (directive[1]!.toLowerCase() === "escape" && (directive[2] === "`" || directive[2] === "\\")) escape = directive[2];
  }

  let index = 0;
  while (index < lines.length) {
    const first = lines[index]!;
    const trimmed = first.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }
    const start = index + 1;
    let text = trimmed;
    // Continuation lines: a trailing escape character; comment lines and blank
    // lines inside a continued instruction are dropped.
    while (text.endsWith(escape)) {
      text = text.slice(0, -1).trimEnd();
      let next: string | undefined;
      while (index + 1 < lines.length) {
        index += 1;
        const candidate = lines[index]!.trim();
        if (candidate !== "" && !candidate.startsWith("#")) {
          next = candidate;
          break;
        }
      }
      if (next === undefined) break;
      text += ` ${next}`;
    }
    index += 1;

    const match = /^([A-Za-z]+)(?:\s+([\s\S]*))?$/u.exec(text);
    const name = match?.[1]?.toUpperCase();
    if (!match || !name || !INSTRUCTIONS.has(name)) {
      errors.push({ line: start, message: `Unknown instruction ${JSON.stringify(text.split(/\s/u)[0] ?? "")}` });
      continue;
    }
    let args = (match[2] ?? "").trim();

    // Heredocs (`RUN <<EOF … EOF`, `COPY <<EOF /file`): the body is not instructions.
    if (name === "RUN" || name === "COPY" || name === "ADD") {
      const delimiters = [...args.matchAll(/<<-?\s*(["']?)([A-Za-z_][\w-]*)\1/gu)].map((heredoc) => heredoc[2]!);
      for (const delimiter of delimiters) {
        while (index < lines.length && lines[index]!.trim() !== delimiter) index += 1;
        if (index >= lines.length) {
          errors.push({ line: start, message: `Heredoc ${JSON.stringify(delimiter)} is not closed` });
          break;
        }
        index += 1;
      }
    }
    if (name === "ONBUILD") {
      const nested = /^([A-Za-z]+)/u.exec(args)?.[1]?.toUpperCase();
      if (!nested || !INSTRUCTIONS.has(nested) || nested === "ONBUILD" || nested === "FROM") {
        errors.push({ line: start, message: `ONBUILD needs another instruction` });
      }
    }
    if (name === "FROM" && args === "") errors.push({ line: start, message: "FROM needs an image" });
    args = args.replace(/\s+/gu, " ");
    instructions.push({ instruction: name, args, line: start, endLine: index });
  }

  return { instructions, errors };
}
