# csharp-signalr

SignalR hubs (Phase 46): classes deriving from `Hub` / `Hub<TClient>`, directly or through a user base hub.

Expected facts (EntryPoint kind `signalr`, library `signalr`, trigger `Hub/method`, property `hubPath` from `MapHub<T>("/path")`):

- `ChatHub` (`hubPath` `/hubs/chat`): `ChatHub/SendMessage`, `ChatHub/join` (`[HubMethodName("join")]` on `JoinRoom`), `ChatHub/Counter`
  (a streaming method), and `ChatHub/Ping` inherited from the abstract user base `AuditedHub<TClient>` (handler `AuditedHub.Ping`).
- `NotificationHub` (`/hubs/notifications`): `Subscribe`, `Unsubscribe`.
- `DraftHub` is never mapped: `Draft` with `hubPath: null`.
- Not EntryPoints: `OnConnectedAsync` / `OnDisconnectedAsync` (overrides: framework lifecycle callbacks), the static `Version`,
  the private `Normalize`, the protected `Audit`, the abstract `AuditedHub` itself, and `NotificationSender` (not a hub).
