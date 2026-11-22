using Inventory.Service.Domain;
using Microsoft.AspNetCore.SignalR;

namespace Inventory.Service.Hubs;

public class StockHub : Hub
{
    private readonly IStockService _stock;

    public StockHub(IStockService stock)
    {
        _stock = stock;
    }

    public async Task Watch(string sku)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, sku);
        await Clients.Caller.SendAsync("stock", _stock.Lookup(sku));
    }

    public override Task OnConnectedAsync() => base.OnConnectedAsync();
}
