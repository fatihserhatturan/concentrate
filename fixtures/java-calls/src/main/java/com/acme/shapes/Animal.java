package com.acme.shapes;

public abstract class Animal {
    public abstract String sound();

    public String speak() {
        return sound();
    }

    public String name() {
        return "animal";
    }
}
