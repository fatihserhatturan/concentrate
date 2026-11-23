using ConfigDemo.Options;
using Microsoft.Extensions.Options;

namespace ConfigDemo.Services;

public class TokenService
{
    private readonly JwtOptions _jwt;

    public TokenService(IOptions<JwtOptions> options)
    {
        _jwt = options.Value;
    }

    public string Issuer() => _jwt.Issuer;

    public TimeSpan Lifetime() => TimeSpan.FromMinutes(_jwt.ExpiryMinutes);
}
