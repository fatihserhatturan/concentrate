package com.acme.orders.web;

import com.acme.orders.domain.OrderEntity;
import com.acme.orders.service.OrderService;
import java.util.List;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
  private final OrderService service;

  public OrderController(OrderService service) {
    this.service = service;
  }

  @PostMapping
  public OrderEntity place(@RequestBody OrderEntity order) {
    return service.place(order);
  }

  @GetMapping
  public List<OrderEntity> open() {
    return service.open();
  }

  @PutMapping("/{id}/ship")
  public int ship(@PathVariable long id) {
    return service.ship(id);
  }

  @GetMapping("/by-customer/{email}")
  public List<String> byCustomer(@PathVariable String email) {
    return service.forCustomer(email);
  }

  @DeleteMapping("/cancelled")
  public int cleanup() {
    return service.cleanup();
  }

  @GetMapping("/region")
  public String region() {
    return service.region();
  }
}
