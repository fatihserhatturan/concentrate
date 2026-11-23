using Gateway.Clients;
using Refit;

namespace Gateway.Services;

public class CatalogService(ICatalogApi catalog)
{
    public Task<Product> FindAsync(int id) => catalog.GetProduct(id);

    public Task<Product> AddAsync(Product product) => catalog.CreateProduct(product);

    public Task RemoveAsync(int id) => catalog.DeleteProduct(id);

    public string Label() => catalog.Describe();
}

public class ShippingService
{
    private readonly IShippingApi _shipping = RestService.For<IShippingApi>("http://localhost:5005");

    public Task<string> StatusAsync(int orderId) => _shipping.Status(orderId);
}
