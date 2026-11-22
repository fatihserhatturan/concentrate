# csharp-solution

A small .NET solution (Phase 45: C# projects and solutions). `Shop.sln` and `Shop.slnx` list the same projects.

Files: `Directory.Build.props` (Company, Copyright = `Copyright $(Company) 2026`, Nullable, LangVersion 12.0, ImplicitUsings enable,
`<Using Include="System.Diagnostics" />`), `Directory.Packages.props` (central package versions).

## Expected projects (5, by project file)
| project | dir | sdk | executable | targets | refs | packages | test |
|---|---|---|---|---|---|---|---|
| `src/Shop.Core/Shop.Core.csproj` | `src/Shop.Core` | Microsoft.NET.Sdk | no | net8.0 | - | - | no |
| `src/Shop.Data/Shop.Data.csproj` | `src/Shop.Data` | Microsoft.NET.Sdk | no | net8.0, net6.0 | Core | Microsoft.EntityFrameworkCore 8.0.4 (central), Microsoft.EntityFrameworkCore.Sqlite 8.0.4 | no |
| `src/Shop.Web/Shop.Web.csproj` | `src/Shop.Web` | Microsoft.NET.Sdk.Web | yes | net8.0 | Core, Data (the third ref, `Shop.Missing`, is unresolved) | - | no |
| `tests/Shop.Tests/Shop.Tests.csproj` | `tests/Shop.Tests` | Microsoft.NET.Sdk | no | net8.0 | Core | Microsoft.NET.Test.Sdk 17.9.0, xunit 2.7.0, xunit.runner.visualstudio 2.5.7 (all central) | yes (IsTestProject) |
| `tools/Orphan/Orphan.csproj` | `tools/Orphan` | Microsoft.NET.Sdk | yes (OutputType Exe) | net8.0 | - | - | no |

All five apply `Directory.Build.props` and `Directory.Packages.props`. `tools/Orphan` is in no solution.
Effective usings: the SDK set for the project's SDK (Web adds the AspNetCore set), plus `System.Diagnostics`; `Shop.Tests` also gets `Xunit`.

## Solutions
- `Shop.sln`: Core, Data, Web, Tests (solution folders `src`, `tests` skipped) plus `src/Shop.Legacy/Shop.Legacy.csproj`, which does not exist: 1 unresolved.
- `Shop.slnx`: the same, with the same missing `Shop.Legacy`: 1 unresolved.
- `solutions` of Core, Data, Web, Tests: `Shop.sln` and `Shop.slnx`; Orphan: none.

## Unresolved counts
- `Shop.Web`: 2 (`$(Nope)` in UserSecretsId; ProjectReference to the missing `..\Shop.Missing\Shop.Missing.csproj`).
- Solutions: 1 + 1. Model total: 4. Every other project: 0.

## Entrypoints
- `Shop.Web`: EntryPoint for the project; it `RUNS` the `main` EntryPoint of the top-level statements of `src/Shop.Web/Program.cs`. `Legacy/Launcher.cs` has a `static Main`, which is NOT an entrypoint (CS7022: the project has top-level statements).
- `Orphan`: EntryPoint for the project; it `RUNS` the `main` EntryPoint of `Orphan.Program.Main` (a project with no top-level statements).
- Libraries and the test project: no project EntryPoint.

## Per-project namespace scoping (usings)
- `src/Shop.Core/GlobalUsings.cs` (`global using Shop.Core.Abstractions;`) applies to every file of Shop.Core only (Domain/Order.cs and Reports/SalesReport.cs use `IClock` without a using).
- `src/Shop.Data/GlobalUsings.cs` (`global using Shop.Data.Models;`) applies to Shop.Data only.
- Negative case: `src/Shop.Core/Reports/SalesReport.cs` uses `OrderRecord` (declared in `Shop.Data.Models`) with no using. Shop.Core does not reference Shop.Data and Shop.Data's global using does not reach it, so `OrderRecord` must stay unresolved.
- Positive: `OrderRepository.cs` uses `OrderRecord` through Shop.Data's own global using; `Shop.Web` and `Shop.Tests` import `Shop.Core.Abstractions` explicitly, which resolves through their ProjectReference to Core.