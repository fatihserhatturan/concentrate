using ConfigDemo.Options;
using Microsoft.Extensions.Options;

namespace ConfigDemo.Services;

public class MailSender(IOptionsSnapshot<MailOptions> options)
{
    public string Endpoint() => $"{options.Value.Host}:{options.Value.Port}";
}
