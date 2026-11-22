using Acme.Core;
using Acme.Models;
using Core = Acme.Core.Helpers;

namespace Acme.App;

public class Program
{
    public static void Main(string[] args)
    {
        var g = new Greeter();
        Console.WriteLine(g.Greet("x"));
        Console.WriteLine(Core.Twice(2));
        var c = Currency.Usd;
        List<int> l = new();
    }
}
