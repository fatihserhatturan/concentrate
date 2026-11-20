import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { JavaParsePlugin } from "../../languages/java/parser.js";

// Java config and environment (Phase 42, track C). Stub: registered, does nothing yet.
//
// The track implements:
//   - `System.getenv("NAME")` and `System.getenv().get("NAME")` as USES_ENV from the function (the file for a
//     field initializer) to an EnvVar (`env:NAME`, as the other languages make it);
//   - `@Value("${key:default}")` on fields, constructor and method parameters, and
//     `@ConfigurationProperties(prefix = …)` classes, as ConfigValue nodes linked to the keys of
//     `application*.properties` / `.yml` (`readSpringConfig` in `config-files.ts`: file and line per
//     key, relaxed binding, profiles); a `${ENV_NAME}` placeholder that is no key (`resolveText`'s
//     `unresolved`) is USES_ENV, and `Environment.getProperty("key")` likewise;
//   - the env variables a config key can be overridden by (`keyToEnvName`).
// The contributor runs before `js-ts.env-config` and `js-ts.env-files` (they link EnvVar and ConfigValue
// nodes across files). The HTTP track reads the same keys through `config-files.ts`, not through this file.
//
// Bump `version` of the plugin when its parse output changes.
export const javaConfigEnvPlugin: JavaParsePlugin & { version: string } = Object.assign<JavaParsePlugin, { version: string }>(() => {}, { version: "0" });

export const javaConfigEnvContributor: ISemanticContributor = {
  id: "java.config-env",
  contribute() {},
};
