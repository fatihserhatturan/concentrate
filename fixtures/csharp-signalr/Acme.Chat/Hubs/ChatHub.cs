using Microsoft.AspNetCore.SignalR;

namespace Acme.Chat.Hubs;

public interface IChatClient
{
    Task ReceiveMessage(string user, string message);
}

public class ChatHub : AuditedHub<IChatClient>
{
    public async Task SendMessage(string user, string message)
    {
        await Clients.All.ReceiveMessage(user, message);
    }

    [HubMethodName("join")]
    public Task JoinRoom(string room) => Groups.AddToGroupAsync(Context.ConnectionId, room);

    public async IAsyncEnumerable<int> Counter(int count)
    {
        for (var i = 0; i < count; i++) yield return i;
        await Task.CompletedTask;
    }

    // Lifecycle callbacks are overrides of the framework: not invocable by clients.
    public override async Task OnConnectedAsync()
    {
        await base.OnConnectedAsync();
    }

    public override Task OnDisconnectedAsync(Exception? exception) => base.OnDisconnectedAsync(exception);

    // Not hub methods: static, non-public.
    public static string Version() => "1";

    private string Normalize(string value) => value.Trim();

    protected void Audit(string what) { }
}
