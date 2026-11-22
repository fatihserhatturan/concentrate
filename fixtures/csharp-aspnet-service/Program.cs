using Inventory.Service.Domain;
using Inventory.Service.Endpoints;
using Inventory.Service.Grpc;
using Inventory.Service.Hubs;
using Inventory.Service.Infrastructure;
using Inventory.Service.Services;
using Inventory.Service.Workers;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddGrpc();
builder.Services.AddSignalR();
builder.Services.AddScoped<IStockRepository, SqlStockRepository>();
builder.Services.AddScoped<IStockService, StockService>();
builder.Services.AddSingleton<IClock, SystemClock>();
builder.Services.AddTransient<INotifier, EmailNotifier>();
builder.Services.AddTransient<INotifier, SmsNotifier>();
builder.Services.AddGrpcClient<Stocker.StockerClient>(options => options.Address = new Uri("https://localhost:5001"));
builder.Services.AddScoped<StockProbe>();
builder.Services.AddHostedService<ReplenishWorker>();
builder.Services.AddHostedService<AuditFlusher>();

var app = builder.Build();

app.MapControllers();
app.MapGrpcService<StockGrpcService>();

var realtime = app.MapGroup("/realtime");
realtime.MapHub<StockHub>("/stock");

var api = app.MapGroup("/minimal").MapGroup("/v1");
api.MapGet("/stock/{sku}", StockHandlers.Peek);
api.MapPost("/stock/{sku}/reserve", (string sku, [FromQuery] int quantity, IStockService stock, ILogger<Program> log) =>
{
    log.LogInformation("reserve {Sku}", sku);
    return stock.Reserve(sku, quantity) ? Results.Ok() : Results.Conflict();
});
api.MapPost("/alerts", StockHandlers.Notify);
app.MapGet("/health", () => Results.Ok());

app.Run();
