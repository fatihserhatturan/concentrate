// What the Java build files (Maven `pom.xml`, Gradle `settings.gradle` / `build.gradle`) tell the
// scan: the modules with their source roots, the modules they depend on and their main class.

export type JavaBuildSystem = "maven" | "gradle";

export type JavaModule = {
  system: JavaBuildSystem;
  // Maven `groupId:artifactId`; Gradle project path (`:app`, `:` for the root project).
  name: string;
  // Directory of the build file, relative to the scan root, posix ("." for the root).
  dir: string;
  // The build file (relative to the scan root) and the line that declares the module (1 when the whole file does).
  file: string;
  line: number;
  version: string | null;
  // Maven `pom` packaging or a Gradle root that only includes others.
  aggregator: boolean;
  // Key (`javaModuleKey`) of the Maven `<parent>` when it is a module of the scan.
  parent: string | null;
  // Source roots relative to the scan root, posix; the conventional ones when the build file sets none.
  sourceRoots: string[];
  testSourceRoots: string[];
  // Other modules of the scan this one depends on, by key, with the Maven scope or Gradle configuration.
  dependencies: Array<{ module: string; scope: string }>;
  // Fully qualified main class and what declared it (`spring-boot-maven-plugin`, `exec-maven-plugin`,
  // `maven-jar-plugin`, `application`).
  mainClass: string | null;
  mainClassSource: string | null;
  // Values worth showing as config (expanded properties, Java release / source / target).
  config: Array<{ key: string; value: string }>;
  // Values the reader could not resolve (an unknown `${property}`, a module path that is no build file).
  unresolved: number;
};

export type JavaBuildModel = {
  modules: JavaModule[];
  // Build files read (relative to the scan root), sorted.
  files: string[];
  unresolved: number;
};

export function javaModuleKey(module: Pick<JavaModule, "system" | "name">): string {
  return `${module.system}:${module.name}`;
}

export function emptyJavaBuildModel(): JavaBuildModel {
  return { modules: [], files: [], unresolved: 0 };
}
