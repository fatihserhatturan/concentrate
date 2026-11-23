using Gateway.Clients;
using Gateway.Services;
using Refit;

var builder = WebApplication.CreateBuilder(args);
var config = builder.Configuration;

builder.Services.AddControllers();

// Typed clients: the base address comes from appsettings.json.
builder.Services.AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri(config["Services:Orders:BaseUrl"]!));
builder.Services.AddHttpClient<IInventoryClient, InventoryClient>(client =>
{
    client.BaseAddress = new Uri(builder.Configuration.GetValue<string>("Services:Inventory:BaseUrl")!);
});

// Named clients: "audit" reads a key no appsettings file has.
builder.Services.AddHttpClient("billing", c => c.BaseAddress = new Uri(config["Services:Billing:BaseUrl"]!));
builder.Services.AddHttpClient("audit", c => c.BaseAddress = new Uri(config["Services:Audit:BaseUrl"]!));

// Refit: one interface configured through the client factory, another built in place.
builder.Services.AddRefitClient<ICatalogApi>().ConfigureHttpClient(c => c.BaseAddress = new Uri("http://localhost:5006"));
builder.Services.AddScoped<BillingGateway>();
builder.Services.AddScoped<CatalogService>();
builder.Services.AddScoped<ShippingService>();
builder.Services.AddScoped<ResponseCache>();
builder.Services.AddScoped<StatusProbe>();

var app = builder.Build();

app.MapControllers();

// The routes the clients above reach.
app.MapGet("/api/inventory/{sku}", (string sku) => Results.Ok(new { sku, quantity = 4 }));
app.MapPut("/api/inventory/{sku}/reserve", (string sku) => Results.NoContent());
app.MapGet("/api/inventory/health", () => Results.Ok());
app.MapGet("/api/billing/invoices", () => Results.Ok(Array.Empty<string>()));
app.MapPost("/api/billing/invoices", () => Results.Created("/api/billing/invoices/1", null));
app.MapGet("/api/catalog/products/{id}", (int id) => Results.Ok(new { id }));
app.MapPost("/api/catalog/products", () => Results.Created("/api/catalog/products/1", null));
app.MapDelete("/api/catalog/products/{id}", (int id) => Results.NoContent());
app.MapGet("/api/shipping/{orderId}/status", (int orderId) => Results.Ok("shipped"));

app.Run();
