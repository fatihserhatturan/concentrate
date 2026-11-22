using Microsoft.AspNetCore.SignalR;

namespace Acme.Chat.Hubs;

// A user base hub: its public methods are invocable on every concrete hub deriving from it.
public abstract class AuditedHub<TClient> : Hub<TClient> where TClient : class
{
    public Task Ping() => Task.CompletedTask;
}
