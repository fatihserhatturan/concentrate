# csharp-syntax-error

Expected:
- `Good.cs` parses cleanly: `Acme.Good`, `Value`. No warning.
- `Broken.cs` has ERROR nodes (`Bad( {` and `int x = ;`): partial graph is kept (class `Acme.Broken`, and at least `Ok`; `AlsoOk` is best-effort), and a scan warning is emitted for this file only.
- Generated classification: `Foo.g.cs`, `Form1.Designer.cs` and `obj/Debug/X.cs` are `generated` files (by `*.g.cs`, `*.Designer.cs`, `obj/`). They still produce nodes (`Foo`, `Form1` partial, `X`) but are flagged generated.
- `Form1` is partial across `Form1.cs` and `Form1.Designer.cs`: one Class node, 2 files; `Form1.cs` is not generated, the Designer file is.
