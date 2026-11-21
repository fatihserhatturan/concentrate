package com.acme.portal.client;

import com.acme.portal.model.User;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpMethod;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

@Service
public class RestTemplateGateway {
  private final RestTemplate rest;

  @Value("${inventory.base-url}")
  private String baseUrl;

  public RestTemplateGateway(RestTemplate rest) { this.rest = rest; }

  public User find(long id) {
    return rest.getForObject(baseUrl + "/users/{id}", User.class, id);
  }

  public User create(User user) {
    return rest.postForObject(baseUrl + "/users", user, User.class);
  }

  public void replace(long id, User user) {
    rest.exchange(baseUrl + "/users/" + id, HttpMethod.PUT, new HttpEntity<>(user), Void.class);
  }

  public void remove(long id) {
    rest.delete(baseUrl + "/users/{id}", id);
  }

  public String lookup(String endpoint) {
    return rest.getForObject(endpoint, String.class);
  }
}
