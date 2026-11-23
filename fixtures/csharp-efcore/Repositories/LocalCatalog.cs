using Shop.Models;

namespace Shop.Repositories;

// Not a DbContext: the same member names as ShopContext, none of it is EF Core.
public class FakeSet<T>
{
    public void Add(T item) { }
}

public class LocalCatalog
{
    public FakeSet<Customer> Customers { get; } = new();
    public List<Order> Orders { get; } = new();

    public void Put(Order order, Customer customer)
    {
        Orders.Add(order);
        Customers.Add(customer);
        var scratch = new List<Order>();
        scratch.Add(order);
    }
}
