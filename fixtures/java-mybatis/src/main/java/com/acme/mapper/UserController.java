package com.acme.mapper;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/users")
public class UserController {
  private final UserService service;

  public UserController(UserService service) {
    this.service = service;
  }

  @GetMapping("/{id}")
  public Object get(@PathVariable long id) {
    return service.load(id);
  }

  @PutMapping("/{id}")
  public int rename(@PathVariable long id) {
    return service.rename(id, "x");
  }

  @GetMapping("/late-orders")
  public List<String> late() {
    return service.lateOrders();
  }
}
