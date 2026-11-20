package com.acme.web;

import static org.springframework.web.reactive.function.server.RequestPredicates.GET;
import static org.springframework.web.reactive.function.server.RequestPredicates.POST;
import static org.springframework.web.reactive.function.server.RequestPredicates.accept;
import static org.springframework.web.reactive.function.server.RequestPredicates.path;
import static org.springframework.web.reactive.function.server.RouterFunctions.nest;
import static org.springframework.web.reactive.function.server.RouterFunctions.route;

import org.springframework.context.annotation.Bean;
import org.springframework.http.MediaType;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.ServerResponse;

public class StaticImportRoutes {
    @Bean
    RouterFunction<ServerResponse> staticRoutes(OrderHandler orders) {
        return nest(path("/static"),
            route(GET("/orders").and(accept(MediaType.APPLICATION_JSON)), orders::all)
                .andRoute(POST("/orders"), orders::one));
    }
}
