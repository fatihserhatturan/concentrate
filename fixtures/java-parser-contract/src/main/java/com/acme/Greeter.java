package com.acme;

import java.util.List;

public class Greeter {
    private final String name;

    public Greeter(String name) {
        this.name = name;
    }

    public String greet(List<String> others) {
        return "Hello " + name + others.size();
    }
}
