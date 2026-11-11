// Shared by the C and C++ parser and the resolvers that read what it records.

// What the names in a function's scope are known to hold, from declarations
// the parser can see: `T x`, `T* p`, `T& r`, `auto x = T(...)`, `new T`,
// `std::make_unique<T>(...)`; `auto x = f()` is whatever `f` returns (found
// once every file is parsed). Other locals are known only to be locals (null).
export type CppLocal = { type: string } | { constructor: string };

// `ns::Foo` from `const ns::Foo<int>&`, `std::unique_ptr<Foo>`, `struct Foo *`;
// null for `auto` and for types that are not a name (`int` is kept, it is
// harmless: no class has that name).
export function normalizeCppType(text: string | null | undefined): string | null {
  if (!text) return null;
  let type = text.replace(/\/\*.*?\*\//gu, " ").replace(/\s+/gu, " ").trim();
  // A smart pointer or wrapper stands for what it holds.
  for (let guard = 0; guard < 4; guard += 1) {
    const wrapped = /^(?:::)?(?:const )?(?:std::)?(?:unique_ptr|shared_ptr|weak_ptr|optional|reference_wrapper|scoped_refptr)\s*<\s*(.+?)\s*(?:,[^<>]*)?>\s*[&*]*$/u.exec(type);
    if (!wrapped) break;
    type = wrapped[1]!;
  }
  // Template arguments (balanced) and qualifiers.
  let depth = 0;
  let stripped = "";
  for (const char of type) {
    if (char === "<") depth += 1;
    else if (char === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0) stripped += char;
  }
  stripped = stripped
    .replace(/[&*]/gu, " ")
    .replace(/\b(?:const|volatile|struct|class|union|enum|typename|static|mutable|constexpr|register|extern|inline|restrict|__restrict|noexcept)\b/gu, " ")
    .replace(/^\s*::/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (stripped === "" || stripped === "auto" || stripped.includes(" ")) return null;
  return stripped;
}

// Names the language itself runs: casts and operators that look like calls.
export const cppNonCalls: ReadonlySet<string> = new Set([
  "static_cast", "dynamic_cast", "reinterpret_cast", "const_cast", "sizeof", "alignof", "typeid", "decltype", "noexcept", "defined", "static_assert", "offsetof",
]);

export const cppSourceExtensions: ReadonlySet<string> = new Set([".c", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".ipp", ".inl", ".h"]);
