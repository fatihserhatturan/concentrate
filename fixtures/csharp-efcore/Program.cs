using Microsoft.EntityFrameworkCore;
using Shop.Data;
using Shop.Repositories;
using Shop.Services;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<ShopContext>(o => o.UseSqlServer("Server=.;Database=shop"));
builder.Services.AddScoped<OrderRepository>();
builder.Services.AddScoped<ReportService>();
builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.MapGet("/reports/revenue", async (ReportService reports) => await reports.RevenueAsync());
app.MapGet("/customers", (ShopContext db) => db.Customers.Where(c => c.Active).ToList());
app.MapDelete("/customers/inactive", async (ReportService reports) => await reports.CleanupAsync());
app.Run();
