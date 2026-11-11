// A small CMake reader (there is no CMake grammar on npm). It splits a
// `CMakeLists.txt` or `.cmake` file into commands and their arguments, skipping
// `#` and `#[[ ]]` comments, and reports a command whose parenthesis never
// closes. Interpreting the commands (variables, targets) is done by
// `languages/cpp/build/cmake.ts`.

export type CMakeArgument = {
  text: string;
  // Written with quotes (a quoted argument is one value, not a `;` list).
  quoted: boolean;
  // Written as a bracket argument `[[...]]` (nothing inside is expanded).
  bracket: boolean;
  line: number;
};

export type CMakeCommand = {
  // Lower-cased: command names are case-insensitive.
  name: string;
  args: CMakeArgument[];
  line: number;
};

export type CMakeRead = {
  commands: CMakeCommand[];
  errors: Array<{ line: number; message: string }>;
};

export function readCMake(source: string): CMakeRead {
  const commands: CMakeCommand[] = [];
  const errors: CMakeRead["errors"] = [];
  const length = source.length;
  let index = 0;
  let line = 1;

  const advance = (count = 1) => {
    for (let step = 0; step < count && index < length; step += 1) {
      if (source[index] === "\n") line += 1;
      index += 1;
    }
  };

  // `[=[ ... ]=]` at `index` (which holds `[`): the level, or -1.
  const bracketOpen = (): number => {
    let at = index + 1;
    let level = 0;
    while (source[at] === "=") {
      level += 1;
      at += 1;
    }
    return source[at] === "[" ? level : -1;
  };

  const readBracket = (level: number): string => {
    const open = level + 2;
    const close = `]${"=".repeat(level)}]`;
    const end = source.indexOf(close, index + open);
    const startAt = index + open;
    const text = source.slice(startAt, end === -1 ? length : end);
    advance((end === -1 ? length : end + close.length) - index);
    // A newline right after the opening bracket is not part of the argument.
    return text.startsWith("\n") ? text.slice(1) : text;
  };

  const skipSpaceAndComments = () => {
    while (index < length) {
      const char = source[index]!;
      if (char === "#") {
        if (source[index + 1] === "[") {
          const level = (() => { index += 1; const found = bracketOpen(); index -= 1; return found; })();
          if (level >= 0) {
            advance(1);
            readBracket(level);
            continue;
          }
        }
        while (index < length && source[index] !== "\n") index += 1;
      } else if (/\s/u.test(char)) {
        advance();
      } else {
        break;
      }
    }
  };

  while (index < length) {
    skipSpaceAndComments();
    if (index >= length) break;
    const nameLine = line;
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(source.slice(index, index + 80));
    if (!nameMatch) {
      errors.push({ line, message: "Expected a command name" });
      while (index < length && source[index] !== "\n") index += 1;
      continue;
    }
    advance(nameMatch[0].length);
    while (index < length && (source[index] === " " || source[index] === "\t")) index += 1;
    if (source[index] !== "(") {
      errors.push({ line: nameLine, message: `Expected ( after ${nameMatch[0]}` });
      while (index < length && source[index] !== "\n") index += 1;
      continue;
    }
    advance();

    const args: CMakeArgument[] = [];
    let depth = 1;
    let closed = false;
    while (index < length) {
      skipSpaceAndComments();
      if (index >= length) break;
      const char = source[index]!;
      if (char === ")") {
        depth -= 1;
        advance();
        if (depth === 0) {
          closed = true;
          break;
        }
        args.push({ text: ")", quoted: false, bracket: false, line });
        continue;
      }
      if (char === "(") {
        depth += 1;
        advance();
        args.push({ text: "(", quoted: false, bracket: false, line });
        continue;
      }
      const argLine = line;
      if (char === "\"") {
        let text = "";
        advance();
        while (index < length && source[index] !== "\"") {
          if (source[index] === "\\" && index + 1 < length) {
            // A backslash-newline continues the line; other escapes stay as written.
            if (source[index + 1] === "\n") {
              advance(2);
              continue;
            }
            text += source[index]! + source[index + 1]!;
            advance(2);
            continue;
          }
          text += source[index];
          advance();
        }
        advance();
        args.push({ text, quoted: true, bracket: false, line: argLine });
        continue;
      }
      if (char === "[") {
        const level = bracketOpen();
        if (level >= 0) {
          args.push({ text: readBracket(level), quoted: true, bracket: true, line: argLine });
          continue;
        }
      }
      let text = "";
      while (index < length && !/[\s()#]/u.test(source[index]!)) {
        if (source[index] === "\\" && index + 1 < length) {
          text += source[index]! + source[index + 1]!;
          advance(2);
          continue;
        }
        // A quote inside an unquoted argument (`-DNAME="x y"`) keeps its text.
        if (source[index] === "\"") {
          text += "\"";
          advance();
          while (index < length && source[index] !== "\"") {
            text += source[index];
            advance();
          }
          text += "\"";
          advance();
          continue;
        }
        text += source[index];
        advance();
      }
      if (text === "") {
        advance();
        continue;
      }
      args.push({ text, quoted: false, bracket: false, line: argLine });
    }
    if (!closed) {
      errors.push({ line: nameLine, message: `Unclosed ( of ${nameMatch[0]}` });
      break;
    }
    commands.push({ name: nameMatch[0].toLowerCase(), args, line: nameLine });
  }
  return { commands, errors };
}
