package com.acme.shop.repo;

import org.springframework.stereotype.Repository;

@Repository
public class JdbcOrderRepository implements OrderRepository {
    @Override
    public String load(String id) {
        return "order " + id;
    }

    @Override
    public String save(String order) {
        return order;
    }

    @Override
    public void purge() {
    }
}
