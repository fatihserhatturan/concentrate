using System.Collections;

namespace ConfigDemo.Infrastructure;

public static class EnvNames
{
    public const string Prefix = "APP_";
    public const string Queue = Prefix + "QUEUE_URL";
}

public class EnvSettings
{
    public string? Queue() => Environment.GetEnvironmentVariable(EnvNames.Queue);

    public string? MachineHome() => Environment.GetEnvironmentVariable("HOME", EnvironmentVariableTarget.Machine);

    public string? Override() => Environment.GetEnvironmentVariable("Jwt__Issuer");

    public object? FromMap()
    {
        IDictionary all = Environment.GetEnvironmentVariables();
        return all["MAP_VALUE"] ?? Environment.GetEnvironmentVariables()["DIRECT_VALUE"];
    }

    public string Expand() => Environment.ExpandEnvironmentVariables("%TEMP%/cache");

    public string? Dynamic(string name) => Environment.GetEnvironmentVariable(name);
}
