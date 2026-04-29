import path from "node:path";
import type { JsTsResolutionConfig } from "./config.js";
import { createJsTsPackageImportBasePaths } from "./package-json.js";

export function createJsTsConfiguredImportBasePaths(
  source: string,
  config: JsTsResolutionConfig,
): string[] {
  const candidates: string[] = [];

  for (const pathMapping of config.paths) {
    const matched = matchPathMapping(source, pathMapping);
    if (!matched) {
      continue;
    }

    for (const targetPattern of pathMapping.targets) {
      candidates.push(applyPathTarget(targetPattern, matched));
    }
  }

  if (config.baseUrl) {
    candidates.push(path.posix.join(config.baseUrl, source));
  }

  candidates.push(...createJsTsPackageImportBasePaths(source, config.packageJson));

  return candidates.map((candidate) => path.posix.normalize(candidate));
}

function matchPathMapping(source: string, mapping: JsTsResolutionConfig["paths"][number]): string | null {
  if (!mapping.pattern.includes("*")) {
    return source === mapping.pattern ? "" : null;
  }

  const [prefix, suffix] = mapping.pattern.split("*", 2);
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) {
    return null;
  }

  return source.slice(prefix.length, source.length - suffix.length);
}

function applyPathTarget(targetPattern: string, matchedWildcard: string): string {
  return targetPattern.includes("*")
    ? targetPattern.replace("*", matchedWildcard)
    : targetPattern;
}
