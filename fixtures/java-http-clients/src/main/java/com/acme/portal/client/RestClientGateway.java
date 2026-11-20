package com.acme.portal.client;

import com.acme.portal.config.Urls;
import com.acme.portal.model.User;
import org.springframework.http.HttpMethod;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

@Service
public class RestClientGateway {
  private final RestClient client;

  public RestClientGateway(RestClient.Builder builder) {
    this.client = builder.baseUrl(Urls.USERS).build();
  }

  public User find(long id) {
    return client.get().uri("/{id}", id).retrieve().body(User.class);
  }

  public User create(User user) {
    return client.method(HttpMethod.POST).uri("").body(user).retrieve().body(User.class);
  }

  public void remove(long id) {
    client.delete().uri(uriBuilder -> uriBuilder.path("/{id}").build(id)).retrieve().toBodilessEntity();
  }

  public String health() {
    return RestClient.create(Urls.ORIGIN).get().uri("/health").retrieve().body(String.class);
  }
}
