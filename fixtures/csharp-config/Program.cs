using ConfigDemo.Infrastructure;
using ConfigDemo.Options;
using ConfigDemo.Services;

var builder = WebApplication.CreateBuilder(args);

var banner = builder.Configuration["Features:Banner"];
var maxItems = builder.Configuration.GetValue<int>("Limits:MaxItems", 50);
var ordersDb = builder.Configuration.GetConnectionString("Orders");
var retries = builder.Configuration.GetValue<int>("Retry:Count", 3);
var jwt = builder.Configuration.GetSection("Jwt").Get<JwtOptions>();

builder.Services.Configure<JwtOptions>(builder.Configuration.GetSection(JwtOptions.SectionName));
builder.Services.Configure<MailOptions>(builder.Configuration.GetSection("Mail"));
builder.Services.AddOptions<StorageOptions>().BindConfiguration("Storage");

builder.Services.AddControllers();
builder.Services.AddSingleton<TokenService>();
builder.Services.AddSingleton<MailSender>();
builder.Services.AddSingleton<StorageMonitor>();
builder.Services.AddSingleton<FeatureFlags>();

var app = builder.Build();
app.MapControllers();
app.MapGet("/banner", (IConfiguration config) => config["Status:Banner"]);
app.MapGet("/region", () => Environment.GetEnvironmentVariable("AWS_REGION"));
app.Run();
