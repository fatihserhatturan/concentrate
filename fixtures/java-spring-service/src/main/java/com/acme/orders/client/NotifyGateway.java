package com.acme.orders.client;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

@Component
public class NotifyGateway {
  private final WebClient web;

  public NotifyGateway(WebClient.Builder builder, @Value("${app.notify.base-url}") String baseUrl) {
    this.web = builder.baseUrl(baseUrl).build();
  }

  public Mono<String> send(String message) {
    return web.post().uri("/api/notify/send").bodyValue(message).retrieve().bodyToMono(String.class);
  }
}
