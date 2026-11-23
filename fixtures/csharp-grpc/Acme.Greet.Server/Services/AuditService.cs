using Acme.Greet;
using Grpc.Core;

namespace Acme.Greet.Server.Services;

// A second implementation of the Greeter service: a call of `SayHello` links to both.
public class AuditService : AuditServiceBase
{
    public override Task<HelloReply> SayHello(HelloRequest request, ServerCallContext context)
        => Task.FromResult(new HelloReply { Message = "audited " + request.Name });
}

// A user base class that carries the service base: the override it declares is inherited by the concrete class.
public abstract class AuditServiceBase : Greeter.GreeterBase
{
    public override Task<HelloReply> Reset(HelloRequest request, ServerCallContext context)
        => Task.FromResult(new HelloReply { Message = "base reset" });
}
