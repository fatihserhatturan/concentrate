import type { LanguageDescriptor } from "../../../core/contracts/language-descriptor.js";

// `module-info.java` and `package-info.java` are Java files; the parser marks them with `File.javaFileKind`.
export const javaLanguages: readonly LanguageDescriptor[] = [
  { id: "java", displayName: "Java", code: true, extensions: [".java"] },
];
