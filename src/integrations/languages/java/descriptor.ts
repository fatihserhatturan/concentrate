import type { LanguageDescriptor } from "../../../core/contracts/language-descriptor.js";

// Surefire's and Failsafe's default includes: `FooTest`, `FooTests`, `FooTestCase`, `TestFoo`, `FooIT`, `FooITCase`.
// `Test` must start a word (`TestUtils`, not `Testament`), `IT` follows a lower-case letter or digit (`FooIT`, not `EDIT`).
// The name alone decides: `LooksLikeTest.java` is a test file. Files under `test/` and `tests/` directories are
// tests by the directory rule, and a file with a test annotation is marked by the Java contributor.
export const isJavaTestFile = (fileName: string): boolean => /^(?:Test[A-Z0-9_]\w*|\w*Tests?|\w*TestCase|\w*[a-z0-9]IT(?:Case)?)\.java$/u.test(fileName);

// `module-info.java` and `package-info.java` are Java files; the parser marks them with `File.javaFileKind`.
export const javaLanguages: readonly LanguageDescriptor[] = [
  { id: "java", displayName: "Java", code: true, extensions: [".java"], testFile: isJavaTestFile },
];
