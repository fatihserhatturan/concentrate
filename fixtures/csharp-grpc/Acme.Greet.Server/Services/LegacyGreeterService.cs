using Acme.Greet;
using Grpc.Core;

namespace Acme.Greet.Server.Services;

// Never registered with MapGrpcService: `registered` is false.
public class LegacyGreeterService : Greeter.GreeterBase
{
    public override Task<HelloReply> SayHello(HelloRequest request, ServerCallContext context)
        => Task.FromResult(new HelloReply { Message = "legacy" });

    public override string ToString() => "legacy greeter";
}
