package com.acme;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class JpaUserRepository implements UserRepository {
    private final JdbcTemplate jdbc;

    public JpaUserRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public String find(String id) {
        return id;
    }
}
