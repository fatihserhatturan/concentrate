namespace FileTool.Cli;

public static class Commands
{
    public static void Add(string file) => Console.WriteLine($"add {file}");

    public static void AddRemote() => Console.WriteLine("remote add");

    public static Task RemoveRemoteAsync(string name) => Task.CompletedTask;
}
