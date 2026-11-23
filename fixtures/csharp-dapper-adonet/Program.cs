using System.Data;
using Ledger.Data;
using Microsoft.Data.SqlClient;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddScoped<IDbConnection>(_ => new SqlConnection("Server=.;Database=ledger"));
builder.Services.AddScoped<OrderRepository>();
builder.Services.AddScoped<CustomerRepository>();

var app = builder.Build();
app.MapControllers();
app.Run();
