using ShopDi;
using ShopDi.Infrastructure;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddShop(builder.Configuration);
builder.Services.AddHostedService<ReminderWorker>();

var app = builder.Build();
app.MapControllers();
app.Run();
