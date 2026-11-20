package com.acme.decl;

public interface Shape {
    double area();

    default String describe() {
        return "shape " + area();
    }
}
