using Fulfilment.Service.Clients;
using Fulfilment.Service.Data;
using Fulfilment.Service.Options;
using Fulfilment.Service.Repositories;
using Fulfilment.Service.Services;
using Microsoft.EntityFrameworkCore;
using Refit;

var builder = WebApplication.CreateBuilder(args);
var config = builder.Configuration;

builder.Services.AddControllers();
builder.Services.AddDbContext<FulfilmentDbContext>(options => options.UseSqlServer(config.GetConnectionString("Fulfilment")));
builder.Services.Configure<CarrierOptions>(config.GetSection("Carriers"));

builder.Services.AddHttpClient<InventoryClient>(c => c.BaseAddress = new Uri(config["Services:Inventory:BaseUrl"]!));
builder.Services.AddRefitClient<IPricingApi>().ConfigureHttpClient(c => c.BaseAddress = new Uri(config["Services:Pricing:BaseUrl"]!));

builder.Services.AddScoped<IOrderRepository, OrderRepository>();
builder.Services.AddScoped<IShipmentRepository, ShipmentRepository>();
builder.Services.AddScoped<OrderService>();
builder.Services.AddScoped<IShipmentService, ShipmentService>();

var app = builder.Build();

app.MapControllers();

app.MapGet("/health", () => Results.Ok(Environment.GetEnvironmentVariable("WEBSITE_SITE_NAME") ?? "local"));
app.MapGet("/minimal/orders/{id}", (int id, OrderService orders) => orders.GetAsync(id));
app.MapGet("/api/stock/{sku}", (string sku) => Results.Ok(new { sku, quantity = 4 }));
app.MapPost("/api/stock/{sku}/reserve", (string sku) => Results.NoContent());
app.MapGet("/api/prices/{sku}", (string sku) => Results.Ok(9.99m));

app.Run();
