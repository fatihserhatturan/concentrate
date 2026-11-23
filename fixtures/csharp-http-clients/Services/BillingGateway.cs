namespace Gateway.Services;

// Named clients through IHttpClientFactory.
public class BillingGateway
{
    private readonly IHttpClientFactory _factory;
    private readonly HttpClient _audit;

    public BillingGateway(IHttpClientFactory factory)
    {
        _factory = factory;
        _audit = factory.CreateClient("audit");
    }

    public async Task<string> InvoicesAsync()
    {
        var client = _factory.CreateClient("billing");
        return await client.GetStringAsync("/api/billing/invoices");
    }

    public Task<HttpResponseMessage> IssueAsync(HttpContent content) => _factory.CreateClient("billing").PostAsync("/api/billing/invoices", content);

    public Task<string> AuditAsync() => _audit.GetStringAsync("/api/audit/events");
}
