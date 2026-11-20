package com.acme;

public class Printer {
    // ambiguous: same arity (1), resolver must count, not guess
    public void print(String s) {}
    public void print(Object o) {}
}
