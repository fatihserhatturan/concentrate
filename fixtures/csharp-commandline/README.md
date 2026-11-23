# csharp-commandline

Phase 46 fixture: a System.CommandLine tool. Commands are built with `new Command(...)` / `new RootCommand(...)`,
nested with `AddCommand`, `Subcommands.Add` or built by a method the root adds, and run by `SetHandler` or
`Handler = CommandHandler.Create(...)`.

Expected EntryPoints (`kind: cli`, `library: system-commandline`). A `RootCommand` takes its name from the executable,
which the code does not give: it is left out of the path (the root alone is `<root>`):

| Trigger | Handler | `resolved` |
| --- | --- | --- |
| `add` | `Commands.Add` (method group) | true |
| `remote add` | `Commands.AddRemote` | true |
| `remote remove` | `Program.Main` (the lambda lives in `Main`) | true |
| `<root>` | `Program.Main` (the root's own lambda) | true |
| `serve` | `ServeCommand.Run` (`Handler = CommandHandler.Create<int>(Run)` in an initializer, command returned by `Build()`) | true |
| `CommandNames.Sync pull` | `SyncCommands.Pull` | false (the `sync` group is named by a constant: written as is, never guessed) |

The `sync` group itself has no handler: no entrypoint. `Program.Main` also keeps its `main` entrypoint.
