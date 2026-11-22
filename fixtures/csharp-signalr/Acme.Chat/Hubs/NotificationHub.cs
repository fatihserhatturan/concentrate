using Microsoft.AspNetCore.SignalR;

namespace Acme.Chat.Hubs;

public class NotificationHub : Hub
{
    public Task Subscribe(string topic) => Groups.AddToGroupAsync(Context.ConnectionId, topic);

    public Task Unsubscribe(string topic) => Groups.RemoveFromGroupAsync(Context.ConnectionId, topic);
}

// Not a hub: a service that merely mentions one.
public class NotificationSender
{
    private readonly IHubContext<NotificationHub> _hub;

    public NotificationSender(IHubContext<NotificationHub> hub) => _hub = hub;

    public Task Send(string topic, string text) => _hub.Clients.Group(topic).SendAsync("notify", text);
}

// A hub that is never mapped: hubPath stays null.
public class DraftHub : Hub
{
    public Task Draft(string text) => Task.CompletedTask;
}
