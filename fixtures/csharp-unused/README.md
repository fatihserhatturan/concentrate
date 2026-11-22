# csharp-unused

Expected `find_unused_exports` (public and internal, C# rules):

Unused (reported):
- `UsedPublic.UnusedMethod`, `UsedPublic.UnusedInternal`, `UsedPublic.UnusedProp`
- `UnusedPublicClass`, `UnusedInternalClass`, `UnusedEnum`
- `IntExt.Triple`
- `Attributed` (the class itself is unused; only its `[Obsolete]` method is exempt)
- `UsedPublic.UnusedPrivate`, `UsedPublic.unusedField` (private unused members are reported too)

Used / not reported: `UsedPublic`, `UsedMethod`, `UsedInternal`, `UsedProp`, `UsedInternalClass`, `IThing`, `ThingImpl`, `UsedEnum`, `IntExt`, `IntExt.Double` (extension call `2.Double()`), `Program.Main` (entrypoint).

Exempt: `ThingImpl.Do` (interface implementation), `ThingImpl.ToString` (override), `Attributed.MarkedMethod` (`[Obsolete]`), `MarkedClass` (`[Marker]`), `MarkerAttribute` (used as attribute), `SomeTests.NeverCalledDirectly` (`[Fact]`).
