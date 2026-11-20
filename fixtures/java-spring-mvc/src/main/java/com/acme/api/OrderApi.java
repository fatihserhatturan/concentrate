package com.acme.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;

@RequestMapping("/orders")
public interface OrderApi {
  @GetMapping("/{id}")
  String find(String id);

  @PostMapping
  String place(String body);
}
