package com.acme.shapes;

public class Dog extends Animal {
    @Override
    public String sound() {
        return "woof";
    }

    @Override
    public String name() {
        return "dog:" + super.name();   // super.m() -> Animal.name
    }

    public String loud() {
        return this.sound() + this.name(); // this.m()
    }
}
