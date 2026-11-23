using System.Data;
using Dapper;
using Microsoft.Data.SqlClient;

namespace Fulfilment.Service.Repositories;

public record Shipment(int Id, int OrderId, string TrackingCode, string Status);

public interface IShipmentRepository
{
    Task<IEnumerable<Shipment>> ForOrderAsync(int orderId);
    Task<int> RecordAsync(int orderId, string trackingCode);
}

public class ShipmentRepository : IShipmentRepository
{
    private readonly string _connectionString;

    public ShipmentRepository(IConfiguration configuration)
    {
        _connectionString = configuration.GetConnectionString("Fulfilment")!;
    }

    private IDbConnection Open() => new SqlConnection(_connectionString);

    public async Task<IEnumerable<Shipment>> ForOrderAsync(int orderId)
    {
        using IDbConnection connection = Open();
        return await connection.QueryAsync<Shipment>("SELECT id, order_id, tracking_code, status FROM shipments WHERE order_id = @orderId", new { orderId });
    }

    public async Task<int> RecordAsync(int orderId, string trackingCode)
    {
        using var connection = new SqlConnection(_connectionString);
        return await connection.ExecuteAsync("INSERT INTO shipments (order_id, tracking_code, status) VALUES (@orderId, @trackingCode, 'created')", new { orderId, trackingCode });
    }
}
