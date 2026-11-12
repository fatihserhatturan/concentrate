import { readFile } from "node:fs/promises";
import path from "node:path";
import { LANGUAGE_NAMES, type SupportedLanguage } from "./language.js";

// concentrate.json at the project root: what the project says about how it
// should be scanned and searched. Every key is optional.
//
//   extensions    file extension → language (".mjsx": "javascript"): files the
//                 scanner would otherwise read as plain text
//   include       glob patterns, as `--include` (a file must match one)
//   exclude       glob patterns, as `--exclude`
//   deprioritize  glob patterns of files that stay in the graph but rank lower
//                 in search_symbols
//   apiOrigins    origins that serve this project's routes, as `--api-origin`
//
// The command line adds to it: `--include` replaces `include`, `--exclude` and
// `--api-origin` are added to the file's lists.

export const PROJECT_SETTINGS_FILE = "concentrate.json";

export type ProjectSettings = {
  extensions: Map<string, SupportedLanguage>;
  include: string[];
  exclude: string[];
  deprioritize: string[];
  apiOrigins: string[];
};

export const EMPTY_SETTINGS: ProjectSettings = { extensions: new Map(), include: [], exclude: [], deprioritize: [], apiOrigins: [] };

export async function loadProjectSettings(rootPath: string): Promise<ProjectSettings> {
  const file = path.join(rootPath, PROJECT_SETTINGS_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_SETTINGS;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${PROJECT_SETTINGS_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseProjectSettings(raw);
}

export function parseProjectSettings(raw: unknown): ProjectSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${PROJECT_SETTINGS_FILE} must be a JSON object`);
  const config = raw as Record<string, unknown>;
  const known = new Set(["extensions", "include", "exclude", "deprioritize", "apiOrigins"]);
  const unknown = Object.keys(config).filter((key) => !known.has(key));
  if (unknown.length > 0) throw new Error(`${PROJECT_SETTINGS_FILE}: unknown key ${unknown.join(", ")}; expected ${[...known].join(", ")}`);

  const list = (key: string): string[] => {
    const value = config[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
      throw new Error(`${PROJECT_SETTINGS_FILE}: ${key} must be a list of non-empty strings`);
    }
    return value as string[];
  };

  const extensions = new Map<string, SupportedLanguage>();
  const mapped = config.extensions;
  if (mapped !== undefined) {
    if (typeof mapped !== "object" || mapped === null || Array.isArray(mapped)) throw new Error(`${PROJECT_SETTINGS_FILE}: extensions must be an object of extension to language`);
    for (const [extension, language] of Object.entries(mapped)) {
      if (!/^\.[^./\\]+$/u.test(extension)) throw new Error(`${PROJECT_SETTINGS_FILE}: extension ${JSON.stringify(extension)} must start with a dot and have no other dot or slash`);
      if (typeof language !== "string" || !(LANGUAGE_NAMES as readonly string[]).includes(language)) {
        throw new Error(`${PROJECT_SETTINGS_FILE}: unknown language ${JSON.stringify(language)} for ${extension}; expected one of ${LANGUAGE_NAMES.join(", ")}`);
      }
      extensions.set(extension.toLowerCase(), language as SupportedLanguage);
    }
  }
  return { extensions, include: list("include"), exclude: list("exclude"), deprioritize: list("deprioritize"), apiOrigins: list("apiOrigins") };
}
