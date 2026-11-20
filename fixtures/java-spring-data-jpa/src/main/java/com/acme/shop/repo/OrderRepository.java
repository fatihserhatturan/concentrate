package com.acme.shop.repo;

import com.acme.shop.domain.Order;
import org.springframework.data.repository.CrudRepository;

public interface OrderRepository extends CrudRepository<Order, Long> {
  Iterable<Order> findByCustomerId(Long customerId);
}
