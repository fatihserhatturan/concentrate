using Refit;

namespace Gateway.Clients;

// Refit interface: base address from AddRefitClient<ICatalogApi>().ConfigureHttpClient in Program.cs.
public interface ICatalogApi
{
    [Get("/api/catalog/products/{id}")]
    Task<Product> GetProduct(int id);

    [Post("/api/catalog/products")]
    Task<Product> CreateProduct([Body] Product product);

    [Headers("Accept: application/json")]
    [Delete("/api/catalog/products/{id}")]
    Task DeleteProduct(int id);

    // No Refit attribute: not a request.
    string Describe();
}

// Base address from RestService.For<IShippingApi>("...") in ShippingService.
public interface IShippingApi
{
    [Get("/api/shipping/{orderId}/status")]
    Task<string> Status(int orderId);
}
