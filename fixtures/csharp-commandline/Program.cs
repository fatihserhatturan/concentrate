using System.CommandLine;
using FileTool.Cli;

namespace FileTool;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var root = new RootCommand("Manages files");
        var fileArgument = new Argument<string>("file");

        // A subcommand with a method as handler.
        var add = new Command("add", "Adds a file");
        add.AddArgument(fileArgument);
        add.SetHandler(Commands.Add, fileArgument);
        root.AddCommand(add);

        // Nested commands: `remote add` and `remote remove`.
        var remote = new Command("remote", "Manages remotes");
        var remoteAdd = new Command("add", "Adds a remote");
        remoteAdd.SetHandler(Commands.AddRemote);
        var remoteRemove = new Command("remove", "Removes a remote");
        remoteRemove.SetHandler(async (string name) => await Commands.RemoveRemoteAsync(name), new Argument<string>("name"));
        remote.AddCommand(remoteAdd);
        remote.Subcommands.Add(remoteRemove);
        root.AddCommand(remote);

        // Built by another method, in another file.
        root.AddCommand(ServeCommand.Build());
        root.AddCommand(SyncCommands.Create());

        // The root runs its own lambda when no subcommand is given.
        root.SetHandler(() => Console.WriteLine("file-tool"));

        return await root.InvokeAsync(args);
    }
}
