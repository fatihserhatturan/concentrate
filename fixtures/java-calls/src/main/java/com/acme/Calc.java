package com.acme;

public class Calc {
    // overloads differing by arity: resolvable by argument count
    public int add(int a, int b) { return a + b; }
    public int add(int a, int b, int c) { return a + b + c; }
}
