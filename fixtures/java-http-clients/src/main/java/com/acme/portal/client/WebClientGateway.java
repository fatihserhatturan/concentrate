package com.acme.portal.client;

import com.acme.portal.config.Urls;
import com.acme.portal.model.User;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

public class WebClientGateway {
  private final WebClient web = WebClient.create(Urls.ORIGIN);

  public Flux<User> search(String q) {
    return web.get().uri("/api/users/search?q={q}", q).retrieve().bodyToFlux(User.class);
  }

  public Mono<User> update(long id, User user) {
    return web.put().uri("/api/users/{id}", id).bodyValue(user).retrieve().bodyToMono(User.class);
  }

  public Mono<String> health() {
    return WebClient.builder().baseUrl(Urls.ORIGIN).build().get().uri(uriBuilder -> uriBuilder.path("/health").build()).retrieve().bodyToMono(String.class);
  }

  public Mono<String> dynamicStart(String origin) {
    return web.get().uri(origin).retrieve().bodyToMono(String.class);
  }
}
