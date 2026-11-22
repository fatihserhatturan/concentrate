# csharp-hosted-service

Phase 46 fixture: `BackgroundService` and `IHostedService` implementations of a worker project, and how they are registered.

Expected facts (`kind: hosted-service`, `library: hosted-service`, trigger = class name, `resolved: true`):

| Trigger | Handler | `registered` |
| --- | --- | --- |
| `QueueWorker` | `QueueWorker.ExecuteAsync` | true (`AddHostedService<QueueWorker>()`) |
| `Heartbeat` | `Heartbeat.StartAsync` (not `StopAsync`) | true |
| `WarmupService` | `WarmupService.StartAsync` (`IHostedLifecycleService`) | true (`AddSingleton<IHostedService, WarmupService>()`) |
| `ReportWorker` | `PeriodicWorker.ExecuteAsync` (inherited) | true |
| `CleanupService` | `CleanupService.ExecuteAsync` | false |

No entrypoint for the abstract `PeriodicWorker` and for `Scheduler` (same method names, no hosted-service base).
`Program.cs` keeps its `main` (top-level statements) entrypoint from `csharp.entrypoints`.
