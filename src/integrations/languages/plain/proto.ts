// A small Protocol Buffers reader (no tree-sitter grammar for `.proto` on
// npm). It reads the top level of a file: syntax, package, imports, messages,
// enums and services with their rpcs, and reports what it cannot read:
// unterminated strings and comments, unbalanced braces and an unknown
// top-level statement.

export type ProtoRpc = {
  name: string;
  request: string;
  response: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  line: number;
};

export type ProtoRead = {
  syntax: string | null;
  package: string | null;
  imports: Array<{ path: string; modifier: "public" | "weak" | null; line: number }>;
  messages: Array<{ name: string; line: number }>;
  enums: Array<{ name: string; line: number }>;
  services: Array<{ name: string; line: number; rpcs: ProtoRpc[] }>;
  errors: Array<{ line: number; message: string }>;
};

type Token = { text: string; line: number; kind: "word" | "string" | "punct" };

export function readProto(source: string): ProtoRead {
  const read: ProtoRead = { syntax: null, package: null, imports: [], messages: [], enums: [], services: [], errors: [] };
  const tokens = tokenize(source, read);
  let index = 0;
  const peek = () => tokens[index];
  const next = () => tokens[index++];

  // Skips a `{ … }` block (the current token is its `{`) and returns false when it is not closed.
  const skipBlock = (): boolean => {
    let depth = 0;
    while (index < tokens.length) {
      const token = next()!;
      if (token.kind === "punct" && token.text === "{") depth += 1;
      if (token.kind === "punct" && token.text === "}" && --depth === 0) return true;
    }
    return false;
  };
  const skipStatement = () => {
    while (index < tokens.length) {
      const token = next()!;
      if (token.kind === "punct" && token.text === ";") return;
      if (token.kind === "punct" && token.text === "{") {
        index -= 1;
        skipBlock();
        return;
      }
    }
  };

  while (index < tokens.length) {
    const token = peek()!;
    if (token.kind === "punct" && token.text === ";") {
      index += 1;
      continue;
    }
    if (token.kind !== "word") {
      read.errors.push({ line: token.line, message: `Unexpected ${JSON.stringify(token.text)}` });
      index += 1;
      continue;
    }
    switch (token.text) {
      case "syntax":
      case "edition": {
        index += 1;
        next(); // =
        const value = next();
        if (token.text === "syntax") read.syntax = value?.text ?? null;
        skipStatement();
        break;
      }
      case "package": {
        index += 1;
        read.package = next()?.text ?? null;
        skipStatement();
        break;
      }
      case "import": {
        index += 1;
        let modifier: "public" | "weak" | null = null;
        if (peek()?.kind === "word" && (peek()!.text === "public" || peek()!.text === "weak")) modifier = next()!.text as "public" | "weak";
        const target = next();
        if (target?.kind === "string") read.imports.push({ path: target.text, modifier, line: token.line });
        else read.errors.push({ line: token.line, message: "import needs a quoted path" });
        skipStatement();
        break;
      }
      case "message":
      case "enum":
      case "service":
      case "extend": {
        index += 1;
        const name = next();
        if (!name || name.kind !== "word") {
          read.errors.push({ line: token.line, message: `${token.text} needs a name` });
          break;
        }
        if (peek()?.text !== "{") {
          read.errors.push({ line: token.line, message: `${token.text} ${name.text} needs a body` });
          break;
        }
        if (token.text === "message") read.messages.push({ name: name.text, line: token.line });
        if (token.text === "enum") read.enums.push({ name: name.text, line: token.line });
        const body = index;
        if (!skipBlock()) {
          read.errors.push({ line: token.line, message: `${token.text} ${name.text} is not closed` });
          break;
        }
        if (token.text === "service") read.services.push({ name: name.text, line: token.line, rpcs: readRpcs(tokens.slice(body + 1, index - 1), read) });
        break;
      }
      case "option":
        skipStatement();
        break;
      default:
        read.errors.push({ line: token.line, message: `Unknown statement ${JSON.stringify(token.text)}` });
        skipStatement();
    }
  }
  return read;
}

// `rpc Name (stream? Request) returns (stream? Response) { … } | ;` in a service body.
function readRpcs(tokens: Token[], read: ProtoRead): ProtoRpc[] {
  const rpcs: ProtoRpc[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.kind !== "word" || token.text !== "rpc") {
      // option statements and stray semicolons
      index += 1;
      while (index < tokens.length && !(tokens[index]!.kind === "punct" && tokens[index]!.text === ";")) index += 1;
      index += 1;
      continue;
    }
    index += 1;
    const name = tokens[index++];
    const take = (): { type: string; stream: boolean } | null => {
      if (tokens[index]?.text !== "(") return null;
      index += 1;
      let stream = false;
      if (tokens[index]?.text === "stream" && tokens[index + 1]?.text !== ")") {
        stream = true;
        index += 1;
      }
      const type = tokens[index++];
      if (tokens[index]?.text !== ")" || !type) return null;
      index += 1;
      return { type: type.text, stream };
    };
    const request = take();
    const returns = tokens[index];
    if (returns?.text === "returns") index += 1;
    const response = returns?.text === "returns" ? take() : null;
    if (!name || name.kind !== "word" || !request || !response) {
      read.errors.push({ line: token.line, message: "Cannot read this rpc" });
      while (index < tokens.length && tokens[index]!.text !== ";" && tokens[index]!.text !== "}") index += 1;
      index += 1;
      continue;
    }
    rpcs.push({ name: name.text, request: request.type, response: response.type, clientStreaming: request.stream, serverStreaming: response.stream, line: token.line });
    if (tokens[index]?.text === "{") {
      let depth = 0;
      while (index < tokens.length) {
        const current = tokens[index++]!;
        if (current.text === "{" && current.kind === "punct") depth += 1;
        if (current.text === "}" && current.kind === "punct" && --depth === 0) break;
      }
    } else if (tokens[index]?.text === ";") {
      index += 1;
    }
  }
  return rpcs;
}

function tokenize(source: string, read: ProtoRead): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\n") {
      line += 1;
      index += 1;
    } else if (/\s/u.test(char)) {
      index += 1;
    } else if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
    } else if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) {
        read.errors.push({ line, message: "Comment is not closed" });
        break;
      }
      line += source.slice(index, end).split("\n").length - 1;
      index = end + 2;
    } else if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < source.length && source[end] !== char && source[end] !== "\n") end += source[end] === "\\" ? 2 : 1;
      if (source[end] !== char) {
        read.errors.push({ line, message: "String is not closed" });
        index = end;
        continue;
      }
      tokens.push({ text: source.slice(index + 1, end), line, kind: "string" });
      index = end + 1;
    } else if (/[A-Za-z_.]/u.test(char)) {
      let end = index + 1;
      while (end < source.length && /[\w.]/u.test(source[end]!)) end += 1;
      tokens.push({ text: source.slice(index, end), line, kind: "word" });
      index = end;
    } else if (/\d|-/u.test(char)) {
      let end = index + 1;
      while (end < source.length && /[\w.+-]/u.test(source[end]!)) end += 1;
      tokens.push({ text: source.slice(index, end), line, kind: "word" });
      index = end;
    } else {
      tokens.push({ text: char, line, kind: "punct" });
      index += 1;
    }
  }
  return tokens;
}
