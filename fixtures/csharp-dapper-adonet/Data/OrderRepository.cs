using System.Data;
using Dapper;
using Microsoft.Data.SqlClient;

namespace Ledger.Data;

public record OrderRow(int Id, int CustomerId, decimal Total, string Status);

public class OrderRepository
{
    private const string SelectOne = "SELECT Id, CustomerId, Total, Status FROM Orders WHERE Id = @id";
    private readonly IDbConnection _db;
    private readonly string _connectionString;

    public OrderRepository(IDbConnection db, string connectionString)
    {
        _db = db;
        _connectionString = connectionString;
    }

    public OrderRow? Find(int id) => _db.QueryFirstOrDefault<OrderRow>(SelectOne, new { id });

    public async Task<IEnumerable<OrderRow>> ListByCustomerAsync(int customerId)
    {
        using var connection = new SqlConnection(_connectionString);
        return await connection.QueryAsync<OrderRow>(
            "SELECT o.Id, o.CustomerId, o.Total, o.Status FROM Orders o JOIN Customers c ON c.Id = o.CustomerId WHERE c.Id = @customerId",
            new { customerId });
    }

    public int Insert(OrderRow order)
    {
        return _db.Execute(
            sql: @"INSERT INTO Orders (Id, CustomerId, Total, Status)
                   VALUES (@Id, @CustomerId, @Total, @Status)",
            param: order);
    }

    public async Task<int> CloseAsync(int id)
    {
        using var connection = new SqlConnection(_connectionString);
        var statement = "UPDATE Orders SET Status = 'closed' WHERE Id = @id";
        return await connection.ExecuteAsync(statement, new { id });
    }

    public Task<int> PurgeAsync(IDbConnection connection)
        => connection.ExecuteAsync(new CommandDefinition("DELETE FROM Orders WHERE Status = 'void'"));

    public decimal Revenue()
    {
        var sql = """
            WITH paid AS (SELECT Total FROM Orders WHERE Status = 'paid')
            SELECT SUM(Total) FROM paid
            """;
        return _db.ExecuteScalar<decimal>(sql);
    }

    public int CountCustomers() => _db.ExecuteScalar<int>($"SELECT COUNT(*) FROM {Tables.Customers}");

    public IEnumerable<OrderRow> SearchBy(string column, string value)
        => _db.Query<OrderRow>("SELECT * FROM Orders WHERE " + column + " = @value", new { value });

    public IEnumerable<OrderRow> Run(string sql) => _db.Query<OrderRow>(sql);

    public IEnumerable<OrderRow> Recent() => _db.Query<OrderRow>("RecentOrders", commandType: CommandType.StoredProcedure);

    public async Task<(IEnumerable<OrderRow>, IEnumerable<int>)> Overview()
    {
        using var multi = await _db.QueryMultipleAsync($"SELECT * FROM {Tables.Orders}; SELECT Id FROM {Tables.Customers}");
        return (await multi.ReadAsync<OrderRow>(), await multi.ReadAsync<int>());
    }
}
