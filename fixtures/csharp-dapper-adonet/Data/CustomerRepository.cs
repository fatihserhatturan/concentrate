using System.Data;
using System.Data.Common;
using Microsoft.Data.SqlClient;
using MySql.Data.MySqlClient;
using Npgsql;

namespace Ledger.Data;

public class CustomerRepository
{
    private readonly string _sqlServer;
    private readonly string _postgres;
    private readonly string _mysql;

    public CustomerRepository(string sqlServer, string postgres, string mysql)
    {
        _sqlServer = sqlServer;
        _postgres = postgres;
        _mysql = mysql;
    }

    public string? EmailOf(int id)
    {
        using var connection = new SqlConnection(_sqlServer);
        connection.Open();
        using var command = new SqlCommand("SELECT Email FROM Customers WHERE Id = @id", connection);
        command.Parameters.AddWithValue("@id", id);
        return command.ExecuteScalar() as string;
    }

    public async Task RenameAsync(int id, string name)
    {
        await using var connection = new NpgsqlConnection(_postgres);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand { Connection = connection, CommandText = "UPDATE Customers SET Name = @name WHERE Id = @id" };
        command.Parameters.AddWithValue("name", name);
        await command.ExecuteNonQueryAsync();
    }

    public void Audit(string message)
    {
        using var connection = new MySqlConnection(_mysql);
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "INSERT INTO AuditLog (Message) VALUES (@message)";
        command.Parameters.AddWithValue("@message", message);
        command.ExecuteNonQuery();
    }

    public void Remove(DbConnection connection, int id)
    {
        using DbCommand command = connection.CreateCommand();
        command.CommandText = $"DELETE FROM {Tables.Customers} WHERE Id = {id}";
        command.ExecuteNonQuery();
    }

    public DataTable Everything()
    {
        using var connection = new SqlConnection(_sqlServer);
        var adapter = new SqlDataAdapter("SELECT * FROM Customers", connection);
        var table = new DataTable();
        adapter.Fill(table);
        return table;
    }

    public void Import(DataTable rows)
    {
        using var connection = new SqlConnection(_sqlServer);
        connection.Open();
        using var bulk = new SqlBulkCopy(connection);
        bulk.DestinationTableName = "AuditLog";
        bulk.WriteToServer(rows);
    }

    public void Reset()
    {
        using var connection = new SqlConnection(_sqlServer);
        connection.Open();
        using var command = new SqlCommand("sp_reset_customers", connection) { CommandType = CommandType.StoredProcedure };
        command.ExecuteNonQuery();
    }

    public void Dynamic(string statement)
    {
        using var connection = new SqlConnection(_sqlServer);
        using var command = new SqlCommand(statement, connection);
        command.ExecuteNonQuery();
    }
}
