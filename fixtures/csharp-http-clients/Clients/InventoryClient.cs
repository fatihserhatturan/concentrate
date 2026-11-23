using System.Net.Http.Json;

namespace Gateway.Clients;

public interface IInventoryClient
{
    Task<Stock?> GetStockAsync(string sku);
    Task ReserveAsync(string sku);
    Task<bool> IsHealthyAsync();
}

// AddHttpClient<IInventoryClient, InventoryClient>: the base of the registration is Services:Inventory:BaseUrl.
public class InventoryClient(HttpClient http) : IInventoryClient
{
    public Task<Stock?> GetStockAsync(string sku) => http.GetFromJsonAsync<Stock>("api/inventory/" + sku);

    public async Task ReserveAsync(string sku)
    {
        using var request = new HttpRequestMessage(HttpMethod.Put, $"/api/inventory/{sku}/reserve");
        var response = await http.SendAsync(request);
        response.EnsureSuccessStatusCode();
    }

    public async Task<bool> IsHealthyAsync()
    {
        var response = await http.SendAsync(new HttpRequestMessage(HttpMethod.Get, new Uri("/api/inventory/health", UriKind.Relative)));
        return response.IsSuccessStatusCode;
    }
}
