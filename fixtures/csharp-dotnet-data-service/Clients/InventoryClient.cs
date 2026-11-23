namespace Fulfilment.Service.Clients;

public class InventoryClient
{
    private readonly HttpClient _http;

    public InventoryClient(HttpClient http) => _http = http;

    public Task<string> StockAsync(string sku) => _http.GetStringAsync($"/api/stock/{sku}");

    public Task ReserveAsync(string sku, int quantity) => _http.PostAsJsonAsync($"/api/stock/{sku}/reserve", new { quantity });
}
