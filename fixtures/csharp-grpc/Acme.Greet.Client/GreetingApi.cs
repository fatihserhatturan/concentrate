using Acme.Greet;
using Grpc.Net.Client;

namespace Acme.Greet.Client;

// A DI-injected client held in a field.
public class GreetingApi
{
    private readonly Greeter.GreeterClient _client;

    public GreetingApi(Greeter.GreeterClient client)
    {
        _client = client;
    }

    public async Task<string> Hello(string name)
    {
        var reply = await _client.SayHelloAsync(new HelloRequest { Name = name });
        return reply.Message;
    }

    public string HelloBlocking(string name) => this._client.SayHello(new HelloRequest { Name = name }).Message;

    public async Task Stream(string name)
    {
        using var call = _client.SayHellos(new HelloRequest { Name = name });
        await foreach (var item in call.ResponseStream.ReadAllAsync()) Console.WriteLine(item.Message);
    }
}

// A primary-constructor client.
public class Pinger(Greeter.GreeterClient greeter)
{
    public void Reset() => greeter.Reset(new HelloRequest());
}

public static class Standalone
{
    // new Greeter.GreeterClient(channel) in a variable, and in place.
    public static string Direct(string address)
    {
        using var channel = GrpcChannel.ForAddress(address);
        var client = new Greeter.GreeterClient(channel);
        var first = client.SayHello(new HelloRequest { Name = "a" });
        var second = new Greeter.GreeterClient(channel).SayHello(new HelloRequest { Name = "b" });
        return first.Message + second.Message;
    }

    // A parameter typed with the client.
    public static Task<HelloReply> Through(Greeter.GreeterClient greeter) => greeter.SayHelloAsync(new HelloRequest { Name = "c" }).ResponseAsync;

    // Receivers of unknown type are never linked.
    public static void Unknown(IServiceProvider provider)
    {
        var made = provider.Make();
        made.SayHello(new HelloRequest());
    }
}

public interface IGreeterProxy
{
    HelloReply SayHello(HelloRequest request);
}

public class Forwarder
{
    private readonly IGreeterProxy _proxy;

    public Forwarder(IGreeterProxy proxy) => _proxy = proxy;

    // IGreeterProxy is not the generated client: not linked.
    public HelloReply Forward() => _proxy.SayHello(new HelloRequest());
}
