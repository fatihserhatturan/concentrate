namespace ConfigDemo.Legacy;

// Negative cases: nothing here reads configuration or the real environment.
public class Environment
{
    public static string? GetEnvironmentVariable(string name) => null;
}

public class Lookup
{
    private readonly Dictionary<string, string> _values = new() { ["Jwt:Issuer"] = "x" };

    public string? Own() => Environment.GetEnvironmentVariable("SHADOWED_VAR");

    public string Dictionary() => _values["Jwt:Issuer"];

    public string Pair(Dictionary<string, string> settings) => settings["Mail:Host"];
}
