package com.acme.model;

public class Address {
    private final String street;

    public Address(String street) {
        this.street = street;
    }

    public String street() {
        return street;
    }
}
