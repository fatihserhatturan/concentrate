package com.acme;

public class Service {
    public String handle(String req) {
        return req;
    }

    public Service chain() {
        return this;
    }

    public Service step() {
        return this;
    }
}
