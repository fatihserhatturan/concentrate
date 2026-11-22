using System;
using Acme.Ext;
using Acme.Shapes;
using Acme.Util;
using static Acme.Util.MathUtil;
using Ghost.Unknown;

namespace Acme.App
{
    public class Service
    {
        private readonly Printer _printer = new Printer();
        public Circle Current { get; set; } = new Circle();
        private IShape? _shape;

        public void Run(Printer p, object unknownReceiver)
        {
            // static / qualified
            MathUtil.Square(2);              // -> MathUtil.Square
            Acme.Util.MathUtil.Square(3);    // fully qualified -> MathUtil.Square
            Greetings.Hello("a");            // -> Greetings.Hello
            // using static
            Sum(1, 2);                       // -> MathUtil.Sum(2 args)
            Sum(1, 2, 3);                    // -> MathUtil.Sum(3 args)
            Fmt(1, "a");                     // ambiguous: 3 overloads, same arg count
            // receivers
            _printer.Print("x");             // field
            Current.Area();                  // property
            p.Print("y");                    // parameter
            var local = new Printer();       // var x = new T()
            local.Print("z");
            Printer t = new();               // target-typed new()
            t.Print("t");
            this.Helper();                   // this
            // chained
            new Printer().Print("a").Self().Inner().Done();
            // interface dispatch: IShape.Area -> ShapeBase.Area (abstract), Circle.Area, Square.Area
            IShape s = new Circle();
            s.Area();
            _shape = new Square();
            _shape.Area();
            // virtual / override
            ShapeBase b = new Circle();
            b.Describe();                    // -> ShapeBase.Describe + Circle.Describe (override)
            // extension methods
            "hi".Shout();                    // -> StringExtensions.Shout
            string str = "a b";
            str.WordCount();                 // -> StringExtensions.WordCount
            // external
            Console.WriteLine("x");          // external (System)
            str.ToUpper();                   // external (System.String)
            Math.Max(1, 2);                  // external
            // unknown receiver: must stay unresolved
            unknownReceiver.Mystery();
            Phantom.Go();                    // type not found anywhere
        }

        private void Helper() { }
    }

    public class Derived : Service
    {
        public void Go()
        {
            base.Run(new Printer(), new object());   // base -> Service.Run
            Run(new Printer(), new object());        // implicit this -> Service.Run (inherited)
        }
    }
}
