namespace Gateway.Services;

// Not HTTP: a class of this scan with HttpClient-looking method names.
public class ResponseCache
{
    private readonly Dictionary<string, string> _entries = new();

    public Task<string?> GetAsync(string key) => Task.FromResult(_entries.GetValueOrDefault(key));

    public Task PostAsync(string key, string value)
    {
        _entries[key] = value;
        return Task.CompletedTask;
    }

    public async Task<string?> WarmAsync(ResponseCache other)
    {
        await other.PostAsync("/api/orders/1", "x");
        return await other.GetAsync("/api/orders/1");
    }
}
