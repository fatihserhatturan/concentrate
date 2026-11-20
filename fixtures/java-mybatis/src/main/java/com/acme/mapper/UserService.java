package com.acme.mapper;

import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class UserService {
  private final UserMapper users;
  private final OrderMapper orders;

  public UserService(UserMapper users, OrderMapper orders) {
    this.users = users;
    this.orders = orders;
  }

  public UserMapper.User load(long id) {
    return users.findById(id);
  }

  public int rename(long id, String name) {
    return users.rename(id, name);
  }

  public List<String> lateOrders() {
    return orders.search("late", null);
  }
}
