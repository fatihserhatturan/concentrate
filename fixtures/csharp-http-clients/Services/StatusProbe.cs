namespace Gateway.Services;

// HttpClient not made by the factory: an object initializer base, an absolute URL with credentials and a dynamic URL.
public class StatusProbe
{
    public async Task<bool> PingAsync()
    {
        using var client = new HttpClient { BaseAddress = new Uri("http://localhost:5002") };
        var response = await client.GetAsync("/api/inventory/health");
        return response.IsSuccessStatusCode;
    }

    public async Task<string> LegacyAsync(HttpClient http, IConfiguration configuration)
    {
        var legacy = configuration["Services:Legacy:BaseUrl"];
        await http.GetAsync("http://svc:s3cret@localhost:5004/api/legacy/ping?verbose=1");
        return await http.GetStringAsync($"{legacy}/api/legacy/status");
    }

    public Task<string> DynamicAsync(HttpClient http, string url) => http.GetStringAsync(url);
}
