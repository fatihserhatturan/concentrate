package com.acme.portal.web;

import com.acme.portal.model.User;
import java.util.List;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
public class UserController {
  @GetMapping("/{id}")
  public User get(@PathVariable long id) { return new User(id, "ada"); }

  @GetMapping("/search")
  public List<User> search(@RequestParam String q) { return List.of(); }

  @PostMapping
  public User create(@RequestBody User user) { return user; }

  @PutMapping("/{id}")
  public User update(@PathVariable long id, @RequestBody User user) { return user; }

  @DeleteMapping("/{id}")
  public void delete(@PathVariable long id) {}
}
