package com.acme.shop.service;

import com.acme.shop.repo.OrderRepository;
import org.springframework.stereotype.Service;

@Service
public class OrderService {
    private final OrderRepository repository;

    public OrderService(OrderRepository repository) {
        this.repository = repository;
    }

    public String find(String id) {
        return repository.load(id);
    }

    public String place(String order) {
        return repository.save(order);
    }

    public void expireStale() {
        repository.purge();
    }
}
