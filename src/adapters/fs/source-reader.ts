import { readFile } from "node:fs/promises";
import type { ISourceReader } from "../../core/contracts/source-reader.js";

/** Reads source files from disk with node:fs. */
export const nodeSourceReader: ISourceReader = {
  readFile: (absolutePath) => readFile(absolutePath, "utf8").catch(() => undefined),
};
