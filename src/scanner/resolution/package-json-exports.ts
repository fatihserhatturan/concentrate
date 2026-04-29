export function extractPackageExportTargets(exportsValue: unknown, subpath: string): string[] {
  if (!exportsValue) {
    return [];
  }

  if (typeof exportsValue === "string" || Array.isArray(exportsValue)) {
    return subpath === "." ? extractConditionalPackageTargets(exportsValue) : [];
  }

  if (!isRecord(exportsValue)) {
    return [];
  }

  const keys = Object.keys(exportsValue);
  const hasSubpathKeys = keys.some((key) => key === "." || key.startsWith("./"));
  if (!hasSubpathKeys) {
    return subpath === "." ? extractConditionalPackageTargets(exportsValue) : [];
  }

  const exact = exportsValue[subpath];
  if (exact) {
    return extractConditionalPackageTargets(exact);
  }

  return extractWildcardPackageExportTargets(exportsValue, subpath);
}

function extractWildcardPackageExportTargets(
  exportsValue: Record<string, unknown>,
  subpath: string,
): string[] {
  const wildcardTargets: string[] = [];
  for (const [pattern, target] of Object.entries(exportsValue)) {
    const matched = matchPackageExportPattern(subpath, pattern);
    if (matched === null) {
      continue;
    }

    for (const targetPattern of extractConditionalPackageTargets(target)) {
      wildcardTargets.push(targetPattern.replaceAll("*", matched));
    }
  }

  return wildcardTargets;
}

function extractConditionalPackageTargets(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(extractConditionalPackageTargets);
  }

  if (!isRecord(value)) {
    return [];
  }

  const preferredConditions = ["types", "import", "module", "default", "require", "node"];
  const targets = preferredConditions.flatMap((condition) => (
    condition in value ? extractConditionalPackageTargets(value[condition]) : []
  ));

  return targets.length > 0
    ? targets
    : Object.values(value).flatMap(extractConditionalPackageTargets);
}

function matchPackageExportPattern(subpath: string, pattern: string): string | null {
  if (!pattern.includes("*")) {
    return null;
  }

  const [prefix, suffix] = pattern.split("*", 2);
  if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) {
    return null;
  }

  return subpath.slice(prefix.length, subpath.length - suffix.length);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
