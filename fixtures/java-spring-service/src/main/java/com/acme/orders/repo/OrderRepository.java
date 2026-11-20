package com.acme.orders.repo;

import com.acme.orders.domain.OrderEntity;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface OrderRepository extends JpaRepository<OrderEntity, Long> {
  List<OrderEntity> findByStatus(String status);

  long countByCustomerEmail(String email);
}
