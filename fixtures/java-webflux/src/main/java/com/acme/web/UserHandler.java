package com.acme.web;

import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;

public class UserHandler {
    public Mono<ServerResponse> list(ServerRequest request) {
        return ServerResponse.ok().build();
    }

    public Mono<ServerResponse> get(ServerRequest request) {
        return ServerResponse.ok().build();
    }

    public Mono<ServerResponse> create(ServerRequest request) {
        return ServerResponse.ok().build();
    }

    public Mono<ServerResponse> remove(ServerRequest request) {
        return ServerResponse.noContent().build();
    }

    // Overloaded: only the ServerRequest one is a handler.
    public Mono<ServerResponse> audit(ServerRequest request) {
        return ServerResponse.ok().build();
    }

    public String audit(String text) {
        return text;
    }
}
