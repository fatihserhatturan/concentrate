using Shop.Core.Abstractions;
using Shop.Data.Repositories;
using Shop.Web.Services;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<IClock, SystemClock>();
builder.Services.AddScoped<OrderRepository>();
builder.Services.AddScoped<CheckoutService>();

var app = builder.Build();
app.MapGet("/", () => "Shop");
app.Run();
