using System;

namespace Acme.Greetings;

public class Greeter
{
    private readonly string _name;

    public Greeter(string name)
    {
        _name = name;
    }

    public string Greet() => Format(_name);

    private static string Format(string value) => $"Hello, {value}";
}
