using HostedServices.Workers;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddHostedService<QueueWorker>();
builder.Services.AddHostedService<Heartbeat>();
builder.Services.AddHostedService<ReportWorker>();
builder.Services.AddSingleton<IHostedService, WarmupService>();

builder.Build().Run();
