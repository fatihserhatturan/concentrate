# csharp-namespaces

Expected graph facts (scan treated as one project):

- Namespace `Acme.Models` is declared by `src/Models/Money.cs` and `src/Models/Deep/Currency.cs` (file-scoped, folders do not match the namespace). `using Acme.Models;` in `app/Program.cs` resolves to BOTH files.
- `Acme.Core` is block-scoped in `Greeter.cs` and file-scoped in `Helpers.cs`; `using Acme.Core;` resolves to both.
- `Acme.Shared` is declared in `src/Models/Deep/Constants.cs` (block-scoped). `global using Acme.Shared;` in `GlobalUsings.cs` applies project-wide.
- `using static Acme.Shared.Constants;` in Greeter.cs resolves to Constants.cs; `Prefix` resolves to `Constants.Prefix`.
- `using Money = Acme.Models.Money;` alias resolves to Money.cs; `using Core = Acme.Core.Helpers;` alias resolves to Helpers.cs (`Core.Twice` -> `Helpers.Twice`).
- External imports: `System`, `System.Text`, `System.Collections.Generic`, `Microsoft.Extensions.Logging`.
- Unresolved (counted, not guessed): `using Acme.Missing.Library;` in Greeter.cs. It is under the scan's own root namespace `Acme` but no file declares it. A using under a foreign root (like `Ghost.Unknown` in csharp-calls) is external and not counted.
- `Console` / `List<int>` in Program.cs come via the global usings of `System` / `System.Collections.Generic` (external).
- Entrypoint: `Program.Main` in `app/Program.cs`.
