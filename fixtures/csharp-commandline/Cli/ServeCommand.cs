using System.CommandLine;
using System.CommandLine.Invocation;
using System.CommandLine.NamingConventionBinder;

namespace FileTool.Cli;

public static class ServeCommand
{
    // The older style: a CommandHandler assigned in an object initializer.
    public static Command Build() =>
        new Command("serve", "Serves the files")
        {
            new Option<int>("--port"),
            Handler = CommandHandler.Create<int>(Run),
        };

    private static void Run(int port) => Console.WriteLine($"serving on {port}");
}

public static class SyncCommands
{
    public static Command Create()
    {
        var sync = new Command(CommandNames.Sync, "Synchronizes");
        var pull = new Command("pull");
        pull.Handler = CommandHandler.Create(Pull);
        sync.AddCommand(pull);
        // A group: `sync` has no handler of its own, so it is no entrypoint, but it names `sync pull`.
        return sync;
    }

    private static Task<int> Pull(InvocationContext context) => Task.FromResult(0);
}

public static class CommandNames
{
    public const string Sync = "sync";
}
