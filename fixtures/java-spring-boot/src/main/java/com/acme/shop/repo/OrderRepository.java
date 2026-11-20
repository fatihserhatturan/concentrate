package com.acme.shop.repo;

public interface OrderRepository {
    String load(String id);

    String save(String order);

    void purge();
}
