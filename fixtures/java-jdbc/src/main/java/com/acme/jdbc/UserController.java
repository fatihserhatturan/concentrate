package com.acme.jdbc;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/users")
public class UserController {
  private final UserDao users;
  private final OrderDao orders;

  public UserController(UserDao users, OrderDao orders) {
    this.users = users;
    this.orders = orders;
  }

  @GetMapping("/{id}")
  public Object get(@PathVariable long id) {
    return users.find(id);
  }

  @PostMapping("/{id}/rename")
  public int rename(@PathVariable long id) {
    return users.rename(id, "x");
  }

  @GetMapping("/{id}/orders")
  public Object orders(@PathVariable long id) {
    return orders.ordersOf(id);
  }
}
