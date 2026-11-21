package com.acme.shop.service;

import com.acme.shop.domain.Customer;
import com.acme.shop.domain.Product;
import com.acme.shop.repo.CustomerRepository;
import com.acme.shop.repo.OrderRepository;
import jakarta.persistence.EntityManager;
import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class CustomerService {
  private final CustomerRepository customers;
  private final OrderRepository orders;
  private final EntityManager em;

  public CustomerService(CustomerRepository customers, OrderRepository orders, EntityManager em) {
    this.customers = customers;
    this.orders = orders;
    this.em = em;
  }

  public Customer register(Customer customer) {
    return customers.save(customer);
  }

  public Customer load(Long id) {
    return customers.findById(id).orElseThrow();
  }

  public boolean active(String email) {
    return customers.findByEmailAndStatus(email, "ACTIVE").isPresent();
  }

  public void forget(Long id) {
    customers.deleteById(id);
    orders.deleteAll(orders.findByCustomerId(id));
  }

  public List<Product> products() {
    return em.createQuery("select p from CatalogProduct p where p.stockLevel > 0", Product.class).getResultList();
  }

  public Product product(Long id) {
    return em.find(Product.class, id);
  }

  public void add(Product product) {
    em.persist(product);
  }

  public int stats() {
    return em.createNativeQuery("select count(*) from order_products").getFirstResult();
  }
}
