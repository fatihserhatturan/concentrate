package com.acme;

import org.springframework.beans.factory.annotation.Autowired;

// Not a provider: nothing is injected into it.
public class Plain {
    @Autowired
    private AuditLog audit;
}
