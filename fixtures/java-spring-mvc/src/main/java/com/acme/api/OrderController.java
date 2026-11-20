package com.acme.api;

import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController implements OrderApi {
  @Override
  public String find(String id) { return id; }

  @Override
  public String place(String body) { return body; }
}
