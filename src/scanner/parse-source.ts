import { parseSourceFile } from "../parsers/index.js";

export type ParseResult =
  | { ok: true; parsed: Awaited<ReturnType<typeof parseSourceFile>>; filePath: string }
  | { ok: false; error: unknown; filePath: string };

export async function parseFileWithContext(
  rootPath: string,
  filePath: string,
  language: Parameters<typeof parseSourceFile>[2],
): ReturnType<typeof parseSourceFile> {
  try {
    return await parseSourceFile(rootPath, filePath, language);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${filePath}: ${message}`, { cause: error });
  }
}
