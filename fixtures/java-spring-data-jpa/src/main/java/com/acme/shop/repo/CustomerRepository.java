package com.acme.shop.repo;

import com.acme.shop.domain.Customer;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface CustomerRepository extends BaseRepository<Customer, Long> {
  Optional<Customer> findByEmailAndStatus(String email, String status);

  long countByStatus(String status);

  boolean existsByEmail(String email);

  void deleteByStatus(String status);

  @Query("select c from Customer c where c.email like :pattern")
  List<Customer> search(@Param("pattern") String pattern);

  @Modifying
  @Query("update Customer c set c.status = :status where c.id = :id")
  int updateStatus(@Param("id") Long id, @Param("status") String status);

  @Query(value = "select * from shop.customers c join orders o on o.customer_id = c.id", nativeQuery = true)
  List<Customer> withOrders();
}
