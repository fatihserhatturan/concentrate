using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using ShopDi.Infrastructure;
using ShopDi.Orders;

namespace ShopDi;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddShop(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<ShopOptions>(configuration.GetSection("Shop"));

        // Interface + implementation, one registration each.
        services.AddScoped<IOrderRepository, SqlOrderRepository>();
        services.AddScoped<IOrderService, OrderService>();
        services.AddSingleton<IClock, SystemClock>();

        // Fluent chain, concrete registrations and the TryAdd family.
        services.AddTransient<CheckoutService>()
                .AddScoped<OrderProjector>();
        services.TryAddScoped<IReportBuilder, ReportBuilder>();

        // Two implementations of one interface: single injection is ambiguous, IEnumerable gets both.
        services.AddTransient<INotifier, EmailNotifier>();
        services.AddTransient<INotifier, SmsNotifier>();

        // Factory with a recognizable `new`, a factory of unknown type, and an instance.
        services.AddScoped<IPriceCalculator>(sp => new PricingEngine(sp.GetRequiredService<IClock>()));
        services.AddScoped<ITaxPolicy>(sp => TaxPolicies.For(sp));
        services.AddSingleton<IAuditLog>(new AuditLog());

        // Open generic through typeof.
        services.AddScoped(typeof(IRepository<>), typeof(Repository<>));

        // Keyed services.
        services.AddKeyedSingleton<ICache, MemoryCache>("memory");
        services.AddKeyedSingleton<ICache, RedisCache>("redis");

        // Typed HTTP client.
        services.AddHttpClient<IPaymentGateway, PaymentGateway>();
        return services;
    }
}
