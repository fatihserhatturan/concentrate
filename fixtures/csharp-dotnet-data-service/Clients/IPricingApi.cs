using Refit;

namespace Fulfilment.Service.Clients;

public interface IPricingApi
{
    [Get("/api/prices/{sku}")]
    Task<decimal> PriceAsync(string sku);

    [Post("/api/quotes")]
    Task<string> QuoteAsync([Body] object request);
}
