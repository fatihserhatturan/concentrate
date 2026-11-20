package com.acme;

import org.springframework.stereotype.Service;

// The only constructor: no annotation needed.
@Service
public class UserService {
    private final UserRepository repository;
    private final AuditLog audit;
    // Not scanned: neither linked nor counted.
    private final org.springframework.web.client.RestTemplate http;

    public UserService(UserRepository repository, AuditLog audit, org.springframework.web.client.RestTemplate http) {
        this.repository = repository;
        this.audit = audit;
        this.http = http;
    }
}
