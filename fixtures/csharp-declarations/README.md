# csharp-declarations

Expected graph facts:

- Types: class (`Animal`, `Duck`, `Outer`, `Members`, `Repository<T>`, `Pair2<,>`, `Widget`), struct (`Point`), interface (`IWalker`, `ISwimmer`, `IMapper`), record class (`Person`, `Employee`), record struct (`Pair`), enum (`Color`, `Outer.InnerEnum`), delegate (`Transformer`, `Notify<T>`).
- Nested: `Outer.InnerPublic` (public), `InnerPrivate` (private), `InnerProtected` (protected struct), `InnerEnum` (internal), `IInner` (public interface).
- `Duck` EXTENDS `Animal`, IMPLEMENTS `IWalker` and `ISwimmer`. `Employee` EXTENDS `Person`.
- `Widget` is `partial` across `Partial.A.cs`, `Partial.B.cs`, `Partial.C.cs`: ONE `Class` node, all 3 files linked; EXTENDS `Animal` (from A), IMPLEMENTS `IWalker` (from B); members from all files (`Width`, `Resize`, `Height`, `Walk`, `Draw`).
- Generics: `Repository<T>` constraint `class, new()`; `Pair2<TKey,TValue>` constraints `notnull, IComparable<TKey>` and `struct`; `IMapper<in TIn, out TOut>` variance; `Util.Identity<T>` method constraint `struct`.
- Visibility on `Members` fields/methods: public, internal, protected, private, `protected internal`, `private protected`, and undeclared (member default = private). Top-level `DefaultInternalClass` (no modifier) = internal; `ExplicitInternalClass` = internal; nested types without modifier = private.
- Member kinds: auto property `AutoProp`, init property `InitProp`, expression-bodied `ExprProp`, indexers (`this[int]`, `this[string,int]`), events (`Changed` field-like, `Tick` with accessors), constructors (instance x3, one static, one chained `: this()`).
- Attributes (Decorator nodes): `[Serializable]` on `Animal` (no args); `[Obsolete("use New", error: false, DiagnosticId = "ACME001")]` on `Members` (positional arg, `error:` named-colon arg, `DiagnosticId =` named property arg); `[System.Diagnostics.Conditional("DEBUG")]` on `Members.Debug` (qualified name).
