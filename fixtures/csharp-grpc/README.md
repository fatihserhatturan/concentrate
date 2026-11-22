# csharp-grpc

gRPC .NET: servers deriving from the generated `X.XBase`, `X.XClient` callers and the `.proto` link (Phase 46).
The generated code is not in the scan, as in a real checkout (it lives in `obj/`).

Expected facts:

- EntryPoints (kind `grpc`, library `grpc-dotnet`, trigger `Service/Method`, one per `public override` rpc method):
  - `Greeter/SayHello`, `Greeter/SayHellos`, `Greeter/Chat` on `GreeterService` (`registered: true`)
  - `Greeter/SayHello` on `AuditService` (`registered: true`) and `Greeter/Reset` on `AuditServiceBase.Reset`, inherited by `AuditService` through the user base class
  - `Greeter/SayHello` on `LegacyGreeterService` (`registered: false`: no `MapGrpcService<LegacyGreeterService>`)
  - `Inventory/GetStock` on `InventoryService` (no proto in the scan: the `ServerCallContext` signature decides; `registered: false`)
  - not EntryPoints: `Describe`, `Compose`, `ToString`, `GetHashCode` overrides, `Panel`/`WidgetBase` (not a generated base)
- `.proto` rpcs `SayHello`, `SayHellos`, `Chat`, `Reset` of `Greeter` get `RPC_IMPLEMENTED_BY` to every implementation (SayHello: three).
- Client calls resolve (`CALL_RESOLVES_TO`, `via: "grpc"`) to each implementation of the called method: a field (`_client`,
  `this._client`), a primary-constructor parameter, a parameter, `var c = new Greeter.GreeterClient(ch)`, and
  `new Greeter.GreeterClient(ch).SayHello(...)`; `SayHelloAsync` links to `SayHello`.
- Not linked: `provider.Make().SayHello()` (unknown type) and `IGreeterProxy.SayHello` (not the generated client).
