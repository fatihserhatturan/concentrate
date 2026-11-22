using System;

Console.WriteLine("hello");
Greeter.Say("world");

static class Greeter
{
    public static void Say(string s) => Console.WriteLine(s);
}
