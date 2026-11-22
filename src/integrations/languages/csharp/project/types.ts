// The model of the C# projects and solutions of a scan: `.csproj` files (with the `Directory.Build.props` and
// `Directory.Packages.props` they inherit from) and `.sln` / `.slnx` files. Every path is relative to the scan root,
// posix. A project is keyed by its `file` (unique).

export type CSharpUsing = {
  namespace: string;
  /** `<Using Include="X" Static="true" />`. */
  static: boolean;
  /** `<Using Include="X" Alias="A" />`. */
  alias: string | null;
};

export type CSharpPackageReference = { name: string; version: string | null };

export type CSharpProject = {
  /** The project file's basename without `.csproj`. */
  name: string;
  file: string;
  /** The directory of `file` ("." for the root). */
  dir: string;
  /** `Microsoft.NET.Sdk`, `Microsoft.NET.Sdk.Web`, `.Worker`, `.Razor`, `.BlazorWebAssembly`, another SDK name, or null (legacy non-SDK project). */
  sdk: string | null;
  /** `OutputType` (default "Library"). */
  outputType: string;
  /** `Exe` / `WinExe`, or a Web / Worker SDK project whose `OutputType` is not `Library`. */
  executable: boolean;
  /** `RootNamespace`, else the project name. */
  rootNamespace: string;
  /** `AssemblyName`, else the project name. */
  assemblyName: string;
  /** `TargetFramework` / `TargetFrameworks` (split on `;`). */
  targetFrameworks: string[];
  implicitUsings: boolean;
  /** Effective: the SDK's implicit set (when enabled) plus `<Using Include>` minus `<Using Remove>`. */
  usings: CSharpUsing[];
  /** Referenced `.csproj` files, normalized. A reference whose target is not a scanned file is counted in `unresolved`, not listed. */
  projectReferences: string[];
  /** Versions come from `PackageReference/@Version` or from the `PackageVersion` of `Directory.Packages.props`. */
  packageReferences: CSharpPackageReference[];
  /** `IsTestProject=true`, or a reference to Microsoft.NET.Test.Sdk, xunit, NUnit or MSTest.TestFramework. */
  isTestProject: boolean;
  /** The `Directory.Build.props` / `Directory.Packages.props` files applied to it. */
  importedProps: string[];
  /** The solution files that list it. */
  solutions: string[];
  /** Expanded properties worth showing (TargetFramework, Nullable, LangVersion, RootNamespace, OutputType, Sdk, ...). */
  config: Array<{ key: string; value: string }>;
  /** Unknown `$(Prop)`, missing ProjectReference target, unknown `Import`. */
  unresolved: number;
  /** ProjectReference items whose target could not be expanded (e.g. `$(SolutionDir)`) or is not among the scanned files. */
  unresolvedReferences: number;
  /** Always 1. */
  line: number;
};

export type CSharpSolution = {
  file: string;
  format: "sln" | "slnx";
  /** The `.csproj` files it lists (scan-relative). */
  projects: string[];
  /** Entries whose project file is not a scanned file. */
  unresolved: number;
};

export type CSharpProjectModel = {
  projects: CSharpProject[];
  solutions: CSharpSolution[];
  /** The project, solution and props files that were read. */
  files: string[];
  unresolved: number;
};

export function emptyCSharpProjectModel(): CSharpProjectModel {
  return { projects: [], solutions: [], files: [], unresolved: 0 };
}

const WEB_USINGS = [
  "System.Net.Http.Json",
  "Microsoft.AspNetCore.Builder",
  "Microsoft.AspNetCore.Hosting",
  "Microsoft.AspNetCore.Http",
  "Microsoft.AspNetCore.Routing",
  "Microsoft.Extensions.Configuration",
  "Microsoft.Extensions.DependencyInjection",
  "Microsoft.Extensions.Hosting",
  "Microsoft.Extensions.Logging",
];
const WORKER_USINGS = [
  "Microsoft.Extensions.Configuration",
  "Microsoft.Extensions.DependencyInjection",
  "Microsoft.Extensions.Hosting",
  "Microsoft.Extensions.Logging",
];

/** The namespaces the .NET SDK imports implicitly when `ImplicitUsings` is enabled, by SDK name. `Microsoft.NET.Sdk` is the base set. */
export const SDK_IMPLICIT_USINGS: Readonly<Record<string, readonly string[]>> = {
  "Microsoft.NET.Sdk": ["System", "System.Collections.Generic", "System.IO", "System.Linq", "System.Net.Http", "System.Threading", "System.Threading.Tasks"],
  "Microsoft.NET.Sdk.Web": ["System", "System.Collections.Generic", "System.IO", "System.Linq", "System.Net.Http", "System.Threading", "System.Threading.Tasks", ...WEB_USINGS],
  "Microsoft.NET.Sdk.Worker": ["System", "System.Collections.Generic", "System.IO", "System.Linq", "System.Net.Http", "System.Threading", "System.Threading.Tasks", ...WORKER_USINGS],
};

/** The implicit namespaces of an SDK name: the table entry, else the base set for any other `Microsoft.NET.Sdk.*`, else none. */
export function implicitUsingsOfSdk(sdk: string | null): readonly string[] {
  if (sdk === null) return [];
  return SDK_IMPLICIT_USINGS[sdk] ?? (sdk.startsWith("Microsoft.NET.Sdk") ? SDK_IMPLICIT_USINGS["Microsoft.NET.Sdk"]! : []);
}
