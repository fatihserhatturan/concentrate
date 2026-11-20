package com.acme.web;

import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/users")
public class UserController {
  @GetMapping
  public String list() { return "[]"; }

  @GetMapping("/{id}")
  public String get(@PathVariable String id) { return id; }

  @PostMapping(path = {"", "/bulk"})
  public String create(@RequestBody String body) { return body; }

  @PutMapping(value = "{id}")
  public String update(@PathVariable String id, @RequestBody String body) { return body; }

  @DeleteMapping("/{id}")
  public void delete(@PathVariable String id) {}

  @RequestMapping(value = "/search", method = {RequestMethod.GET, RequestMethod.POST})
  public String search() { return ""; }

  @RequestMapping("/ping")
  public String ping() { return "pong"; }

  @GetMapping(Paths.BASE + "/dynamic")
  public String dynamic() { return ""; }

  public String notAnEndpoint() { return ""; }
}
