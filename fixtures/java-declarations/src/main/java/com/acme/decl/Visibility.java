package com.acme.decl;

public class Visibility {
    public int pub;
    protected int prot;
    int pkg;
    private int priv;

    public static int counter;

    public void publicMethod() {}
    protected void protectedMethod() {}
    void packageMethod() {}
    private void privateMethod() {}

    public static void staticMethod() {}
}

// package-private top-level type in the same file
class Hidden {
    void touch() {}
}
