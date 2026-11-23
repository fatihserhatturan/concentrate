namespace Gateway.Clients;

public record Order(int Id, string Sku, int Quantity);

public record Stock(string Sku, int Quantity);

public record Product(int Id, string Name);
