package com.acme.web;

import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;

public class OrderHandler {
    public Mono<ServerResponse> all(ServerRequest request) {
        return ServerResponse.ok().build();
    }

    public Mono<ServerResponse> one(ServerRequest request) {
        return ServerResponse.ok().build();
    }

    public static Mono<ServerResponse> health(ServerRequest request) {
        return ServerResponse.ok().build();
    }
}
