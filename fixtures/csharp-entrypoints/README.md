# csharp-entrypoints

Expected `EntryPoint` nodes:
- `classic/Program.cs`: `Classic.Program.Main(string[] args)` (static void Main).
- `asyncmain/Program.cs`: `AsyncApp.Entry.Main` (`private static async Task<int> Main`).
- `toplevel/Program.cs`: top-level statements; the file itself is the entrypoint (no `Main` method). `Greeter.Say` is called from it.

NOT entrypoints: `Classic.Helper.Main()` (instance) and `Helper.Main(int)` (wrong signature) in `classic/NotMain.cs`.

Note: the three subdirs are separate programs; a real compiler would reject them as one project, the scanner treats files individually.
