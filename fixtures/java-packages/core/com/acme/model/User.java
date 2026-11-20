package com.acme.model;

import java.util.List;
import javax.annotation.Nullable;

public class User {
    private final String name;
    private final List<String> roles;

    public User(String name, List<String> roles) {
        this.name = name;
        this.roles = roles;
    }

    @Nullable
    public String firstRole() {
        return roles.isEmpty() ? null : roles.get(0);
    }

    public String getName() {
        return name;
    }

    // same-package type used without import
    public Address homeAddress() {
        return new Address("Main St");
    }
}
