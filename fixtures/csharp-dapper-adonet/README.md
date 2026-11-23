# csharp-dapper-adonet

An ASP.NET Core ledger service that reaches SQL Server, PostgreSQL and MySQL through Dapper and plain ADO.NET (Phase 47,
track B). `schema.sql` declares the tables (`Customers`, `Orders`, `AuditLog`; `sql.schema` fills their columns).

## Expected facts

`ACCESSES_DATA` (`direct: true`; function -> DataModel `datamodel:<library>:<table>`, `operation`, `library`).

Dapper (library `dapper`), in `OrderRepository`:
- `Find` -> orders read (`QueryFirstOrDefault<T>` with a `const` SQL, receiver `IDbConnection` field).
- `ListByCustomerAsync` -> orders read, customers read (`QueryAsync<T>`, join; receiver `new SqlConnection(..)` local).
- `Insert` -> orders create (`Execute(sql: @"INSERT ...")`, named argument, verbatim string).
- `CloseAsync` -> orders update (SQL in a single-assignment local).
- `PurgeAsync` -> orders delete (`new CommandDefinition("DELETE ...")`, receiver is a parameter).
- `Revenue` -> orders read (raw string literal, CTE `paid` is not a table).
- `CountCustomers` -> customers aggregate (`COUNT(*)`, interpolated `{Tables.Customers}` = `dbo.Customers`).
- `SearchBy` -> orders read (concatenation: the literal text names the table, the column is dynamic).
- `Overview` -> orders read, customers read (`QueryMultipleAsync`, interpolated constants).

ADO.NET (library `ado.net`), in `CustomerRepository`:
- `EmailOf` -> customers read (`new SqlCommand("..", conn)`).
- `RenameAsync` -> customers update (`new NpgsqlCommand { CommandText = ".." }`).
- `Everything` -> customers read (`new SqlDataAdapter("..", conn)`).
- `Audit` -> auditlog create (`var cmd = conn.CreateCommand(); cmd.CommandText = ".."`, `MySqlConnection`).
- `Remove` -> customers delete (`DbCommand` from `DbConnection.CreateCommand()`, interpolated constant).
- `Import` -> auditlog create (`SqlBulkCopy.DestinationTableName`).

Nothing: `Run` (wholly dynamic parameter), `Recent` (`commandType: CommandType.StoredProcedure`), `Reset` (stored procedure),
`Dynamic` (the SQL is a parameter), `Legacy/Lookalikes.cs` (`SearchIndex.Query/Execute` of an own class, a scanned `SqlCommand`
class, SQL-looking strings that are never passed to a database).

Tables: `customers`, `orders`, `auditlog` (one each, `table:csharp:-:<name>`), mapped from the stand-in DataModels of both
libraries (`datamodel:dapper:orders`, `datamodel:ado.net:orders`, ...).

Callers: `OrdersController.Get` reaches `orders` read, `Close` orders update and `Rename` customers update with
`direct: false`; `impact_of` on `CloseAsync` reaches `OrdersController.Close`.
