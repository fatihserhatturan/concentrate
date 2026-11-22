using System;

namespace Acme.Decl;

[Serializable]
public class Animal
{
    public virtual string Name { get; set; } = "";
    public virtual void Speak() { }
}

public interface IWalker { void Walk(); }
public interface ISwimmer { void Swim(); int Depth { get; } }

public class Duck : Animal, IWalker, ISwimmer
{
    public Duck() { }
    public Duck(string name) { Name = name; }
    public void Walk() { }
    public void Swim() { }
    public int Depth => 1;
    public override void Speak() { }
}

public struct Point { public int X; public int Y; }
public readonly record struct Pair(int A, int B);
public record Person(string First, string Last);
public record class Employee(string First, string Last, int Level) : Person(First, Last);

public enum Color { Red, Green = 5, Blue }

public delegate int Transformer(int input);
public delegate void Notify<T>(T item) where T : class;

public class Outer
{
    public class InnerPublic { }
    private class InnerPrivate { }
    protected struct InnerProtected { }
    internal enum InnerEnum { A, B }
    public interface IInner { }
}
