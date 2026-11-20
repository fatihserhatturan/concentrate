package com.acme.api;

public class UsedApi {
    public String used() { return "u"; }    // called from other package
    public String neverCalled() { return "n"; }  // public, never called
    String pkgUsed() { return "p"; }        // called from same package (Internal)
}
