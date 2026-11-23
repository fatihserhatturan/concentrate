# csharp-config

ASP.NET Core service for the C# configuration and environment track (Phase 47, track C), as `java-spring-config` is for
Java. `tests/csharp-config.test.ts` asserts the facts below; the golden `tests/golden/fixtures/csharp-config.jsonl` and the
query cases `csharp-config` record the graph.

## Config files

`appsettings.json` (with comments and a trailing comma), `appsettings.Development.json` and `appsettings.Production.json`:
every leaf is a ConfigValue declared by its file (`DECLARES_CONFIG`), 28 in all. A key of the Development / Production
file is its own node (`Jwt:Issuer` exists in `appsettings.json` and in `appsettings.Production.json`). Arrays are indexed
(`Mail:Recipients:0`). Redacted: `Jwt:SigningKey` (secret name), `Payments:ApiKey`, and the `Password=` of
`ConnectionStrings:Orders` (`Server=db.local;Database=orders;User Id=app;Password=<redacted>;`).

## Environment (USES_ENV, from the function and its file)

| Function | EnvVar | Why |
| --- | --- | --- |
| `EnvSettings.Queue` | `APP_QUEUE_URL` | constant `EnvNames.Queue` = `Prefix + "QUEUE_URL"` |
| `EnvSettings.MachineHome` | `HOME` | `EnvironmentVariableTarget.Machine` overload |
| `EnvSettings.Override` | `Jwt__Issuer` | explicit read of an override name |
| `EnvSettings.FromMap` | `MAP_VALUE`, `DIRECT_VALUE` | `GetEnvironmentVariables()["X"]`, directly and through a local |
| `EnvSettings.Expand` | `TEMP` | `ExpandEnvironmentVariables("%TEMP%/cache")` |
| `StatusController.Deployment` | `DEPLOY_ENV` | `System.Environment.GetEnvironmentVariable` |
| `<top-level>` (Program.cs) | `AWS_REGION` | read inside a minimal API lambda |

Nothing for `EnvSettings.Dynamic(string name)` (name not constant) and `Lookup.Own` (`ConfigDemo.Legacy.Environment` is a
scanned type, not System's).

## Config reads (CONSUMES_CONFIG, localName = key)

- `<top-level>`: `Features:Banner`, `Limits:MaxItems` (`GetValue<int>`), `ConnectionStrings:Orders` (`GetConnectionString`),
  `Retry:Count` (no file defines it: a ConfigValue of `Program.cs`, valueType `default`, value `3`), `Jwt` (`GetSection("Jwt").Get<JwtOptions>()`:
  every key below it) and the options registrations (`JwtOptions` from `JwtOptions.SectionName`, `MailOptions`, `StorageOptions`
  from `BindConfiguration("Storage")`) as the keys below their sections. The lambda `(IConfiguration config) => config["Status:Banner"]`
  reads `Status:Banner` and only the `/banner` route gets it (the top-level function's own reads belong to no route).
- `FeatureFlags.CacheSeconds`: `Features:Cache:Ttl:Seconds` through section locals (`cache` then `ttl["Seconds"]`).
- `FeatureFlags.BannerText`: `Features:Banner` (`GetSection("Features").GetSection("Banner").Value`).
- `FeatureFlags.Legacy`: `Unset:Key` (valueType `unset`, empty value) and `Features:Fallback` (valueType `default`, value `none`).
- `FeatureFlags.LogLevels`: every key below `Logging:LogLevel` (`GetChildren()`).
- `StatusController.Get`: `Status:Banner`, and the route `GET /api/status`.
- Options consumers: `TokenService` constructor (`IOptions<JwtOptions>`) reads `Jwt:*`, `MailSender` (primary constructor,
  `IOptionsSnapshot<MailOptions>`) reads `Mail:*` incl. the array items, `StorageMonitor` constructor (`IOptionsMonitor<StorageOptions>`)
  reads `Storage:*`.

Every exact key read that an appsettings file defines is also `USES_ENV` (`access: "config override"`) of the variable that overrides it:
`Features__Banner`, `Limits__MaxItems`, `ConnectionStrings__Orders`, `Status__Banner`, `Features__Cache__Ttl__Seconds`.
Section reads and options list no override.

## Negative cases (nothing emitted)

`Lookup.Dictionary` (`_values["Jwt:Issuer"]` of a `Dictionary<string, string>`) and `Lookup.Pair` (`settings["Mail:Host"]`).
