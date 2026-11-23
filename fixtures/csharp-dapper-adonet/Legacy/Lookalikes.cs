using Dapper;

namespace Ledger.Legacy;

// Not Dapper: a scanned class with its own Query / Execute methods.
public class SearchIndex
{
    public IEnumerable<string> Query(string text) => new[] { text };

    public int Execute(string text) => text.Length;
}

public class Reports
{
    private readonly SearchIndex _index = new();

    // The strings below look like SQL but never reach a database.
    public const string Help = "SELECT * FROM Orders is how you list orders";

    public IEnumerable<string> Find()
    {
        var phrase = "DELETE FROM Customers";
        Console.WriteLine(phrase);
        _index.Execute("UPDATE Orders SET Status = 'x'");
        return _index.Query("SELECT Id FROM Orders");
    }
}

// A scanned command type of the same name as System's: not ADO.NET.
public class SqlCommand
{
    public SqlCommand(string text) { Text = text; }
    public string Text { get; }
}

public class Wrapper
{
    public SqlCommand Make() => new SqlCommand("SELECT * FROM Customers");
}
