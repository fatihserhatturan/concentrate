package com.acme.api;

// public API type nobody uses: public API of a library, kept by the public-API rule
public class PublicApi {
    public void exposed() {}                // public, unused
    protected void hook() {}                // protected, unused (subclass extension point)
    void pkgOnly() {}                       // package-private, unused -> unused
    private void secret() {}                // private, unused -> unused
}
