# csharp-calls

Expected resolution (caller is `Acme.App.Service.Run` unless noted):

Resolved, single target:
- `MathUtil.Square(2)`, `Acme.Util.MathUtil.Square(3)` -> `MathUtil.Square`
- `Greetings.Hello("a")` -> `Greetings.Hello` (via `using Acme.Util;`)
- `Sum(1,2)` (bare name through `using static`) -> `MathUtil.Sum` 2-arg overload; `Sum(1,2,3)` -> 3-arg overload (told apart by argument count)
- `_printer.Print`, `p.Print`, `local.Print`, `t.Print` (field, parameter, `var x = new T()`, target-typed `new()`) -> `Printer.Print`
- `Current.Area()` (property typed `Circle`) -> `Circle.Area`
- `this.Helper()` -> `Service.Helper`
- chain `new Printer().Print("a").Self().Inner().Done()` -> `Printer.Print`, `Printer.Self`, `Printer.Inner`, `Stack.Done` (each through return types)
- `"hi".Shout()` and `str.WordCount()` -> `StringExtensions.Shout` / `WordCount` (extension methods from namespace `Acme.Ext` via `using`)
- `Derived.Go`: `base.Run(...)` and `Run(...)` -> `Service.Run`

Dispatch (marked as interface/virtual dispatch, reaches every implementation):
- `s.Area()` / `_shape.Area()` (type `IShape`) -> `IShape.Area` plus `ShapeBase.Area`, `Circle.Area`, `Square.Area`
- `b.Describe()` (type `ShapeBase`) -> `ShapeBase.Describe` and override `Circle.Describe`
- `Circle.Describe` calls `base.Describe()` -> `ShapeBase.Describe`

Overload-ambiguous (counted as ambiguous, not guessed):
- `Fmt(1, "a")`: three `MathUtil.Fmt` overloads share the arg count (2); the argument types drop `Fmt(string, int)`, so it narrows to 2 candidates (`Fmt(int, string)` and `Fmt(object, object)`), both marked `via: "overload"`

External (not resolved to project nodes): `Console.WriteLine`, `str.ToUpper`, `Math.Max`, `System.Console.WriteLine` in Shape.cs, `ToUpperInvariant`, `Split`.

Must stay unresolved (counted): `unknownReceiver.Mystery()` (receiver `object`, no such method), `Phantom.Go()` (no such type). `using Ghost.Unknown;` is an external import (foreign root namespace, the Java rule), not counted as unresolved; a using under the scan's own root namespace that no file declares (like `Acme.Missing.Library` in csharp-namespaces) is counted.
