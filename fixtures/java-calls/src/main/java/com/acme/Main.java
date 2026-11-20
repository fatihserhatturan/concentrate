package com.acme;

import static com.acme.util.MathUtil.thrice;
import com.acme.shapes.Animal;
import com.acme.shapes.Circle;
import com.acme.shapes.Dog;
import com.acme.shapes.Shape;
import com.acme.shapes.Square;
import com.acme.util.MathUtil;
import java.util.function.Supplier;
import java.util.function.Function;
import org.external.Remote;

public class Main {
    private final Service service = new Service();   // constructor call, typed field
    private final Calc calc = new Calc();
    private final Printer printer = new Printer();

    public String run(String req) {
        return service.handle(req);                  // via field
    }

    public int statics() {
        int a = MathUtil.twice(2);                   // Type.m()
        int b = thrice(3);                           // static import call
        return a + b;
    }

    public String locals(Service param) {
        Service local = new Service();
        var inferred = new Service();                // var x = new T()
        local.handle("a");                           // typed local
        param.handle("b");                           // typed parameter
        inferred.handle("c");                        // var-inferred
        return this.run("d");                        // this.m()
    }

    public void chained() {
        service.chain().step().handle("x");          // chained: chain->step->handle
    }

    public int overloads() {
        int one = calc.add(1, 2);                    // resolves to add(int,int)
        int two = calc.add(1, 2, 3);                 // resolves to add(int,int,int)
        printer.print("s");                          // ambiguous: print(String)/print(Object)
        return one + two;
    }

    public double dispatch(Shape shape, Animal animal) {
        animal.speak();                              // Animal.speak (concrete)
        animal.sound();                              // abstract: Dog.sound implementation
        return shape.area();                         // interface: Circle.area + Square.area
    }

    public void instances() {
        Shape c = new Circle();
        Shape s = new Square();
        c.area();
        s.area();
        new Dog().loud();
    }

    public void refs() {
        Function<Integer, Integer> f = MathUtil::twice;   // Foo::bar
        Function<String, String> g = this::run;           // this::bar
        Supplier<Service> h = Service::new;               // Foo::new
        f.apply(1);
        g.apply("z");
        h.get();
    }

    public void external(Remote remote) {
        remote.doSomethingUnknown();                 // unknown method, unresolved external type
        Remote.staticUnknown();
    }
}
