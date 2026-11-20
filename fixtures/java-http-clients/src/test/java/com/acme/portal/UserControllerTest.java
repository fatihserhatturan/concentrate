package com.acme.portal;

import org.springframework.web.client.RestTemplate;

// A test drives the app: not an outbound request of the service.
public class UserControllerTest {
  private final RestTemplate rest = new RestTemplate();

  void healthy() {
    rest.getForObject("http://localhost:8080/health", String.class);
  }
}
