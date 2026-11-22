using Acme.Greet;
using Grpc.Core;

namespace Acme.Greet.Server.Services;

public class GreeterService : Greeter.GreeterBase
{
    private readonly ILogger<GreeterService> _logger;

    public GreeterService(ILogger<GreeterService> logger)
    {
        _logger = logger;
    }

    public override Task<HelloReply> SayHello(HelloRequest request, ServerCallContext context)
    {
        _logger.LogInformation("Hello {Name}", request.Name);
        return Task.FromResult(new HelloReply { Message = Compose(request.Name) });
    }

    public override async Task SayHellos(HelloRequest request, IServerStreamWriter<HelloReply> responseStream, ServerCallContext context)
    {
        for (var i = 0; i < 3; i++)
        {
            await responseStream.WriteAsync(new HelloReply { Message = Compose(request.Name) });
        }
    }

    public override async Task Chat(IAsyncStreamReader<HelloRequest> requestStream, IServerStreamWriter<HelloReply> responseStream, ServerCallContext context)
    {
        await foreach (var message in requestStream.ReadAllAsync())
        {
            await responseStream.WriteAsync(new HelloReply { Message = Compose(message.Name) });
        }
    }

    // Not an rpc: a private helper.
    private static string Compose(string name) => $"Hello {name}";

    // Not an rpc: public, but not an override of the generated base.
    public string Describe() => "greeter";
}
