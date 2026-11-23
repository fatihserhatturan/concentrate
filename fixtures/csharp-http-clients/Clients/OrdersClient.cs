using System.Net.Http.Json;

namespace Gateway.Clients;

// A typed client: registered with AddHttpClient<OrdersClient>, base address Services:Orders:BaseUrl.
public class OrdersClient
{
    private const string Root = "/api/orders";
    private readonly HttpClient _http;

    public OrdersClient(HttpClient http)
    {
        _http = http;
    }

    public Task<Order?> GetOrderAsync(int id) => _http.GetFromJsonAsync<Order>($"{Root}/{id}");

    public async Task<HttpResponseMessage> PlaceAsync(Order order) => await _http.PostAsJsonAsync(Root, order);

    public async Task CancelAsync(int id)
    {
        var response = await _http.DeleteAsync($"{Root}/{id}?reason=customer");
        response.EnsureSuccessStatusCode();
    }

    public Task<string> RawAsync(string path) => _http.GetStringAsync(path);
}
