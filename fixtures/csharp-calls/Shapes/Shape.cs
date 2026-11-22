namespace Acme.Shapes
{
    public interface IShape { double Area(); }

    public abstract class ShapeBase : IShape
    {
        public abstract double Area();
        public virtual string Describe() => "shape " + Area();
    }

    public class Circle : ShapeBase
    {
        public double R;
        public override double Area() => 3.14 * R * R;
        public override string Describe() => "circle/" + base.Describe();
    }

    public class Square : ShapeBase
    {
        public double S;
        public override double Area() => S * S;
    }

    public class Printer
    {
        public Printer Self() => this;
        public Printer Print(string s) { System.Console.WriteLine(s); return this; }
        public Stack Inner() => new Stack();
    }

    public class Stack
    {
        public void Done() { }
    }
}
