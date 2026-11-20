package com.acme.api;

public class Facade {
    private int cache;                      // private field, unused

    public String run() {
        return new Internal().go() + helper();
    }

    private String helper() { return "h"; } // private, used
    private String orphan() { return "o"; } // private, unused -> unused
}
