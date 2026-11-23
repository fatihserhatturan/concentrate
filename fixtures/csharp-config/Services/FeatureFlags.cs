namespace ConfigDemo.Services;

public class FeatureFlags
{
    private readonly IConfiguration _configuration;

    public FeatureFlags(IConfiguration configuration)
    {
        _configuration = configuration;
    }

    public int CacheSeconds()
    {
        var cache = _configuration.GetSection("Features:Cache");
        var ttl = cache.GetSection("Ttl");
        return int.Parse(ttl["Seconds"] ?? "0");
    }

    public string BannerText()
    {
        return _configuration.GetSection("Features").GetSection("Banner").Value ?? "";
    }

    public string Legacy()
    {
        return _configuration["Unset:Key"] ?? _configuration.GetValue<string>("Features:Fallback", "none") ?? "";
    }

    public IEnumerable<string> LogLevels()
    {
        foreach (var child in _configuration.GetSection("Logging:LogLevel").GetChildren())
        {
            yield return child.Key;
        }
    }
}
