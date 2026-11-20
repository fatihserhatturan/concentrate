package com.acme.lombok;

// An own `Value` annotation, no Spring.
public class Account {
  @Value("${app.name}")
  private String name;
}
