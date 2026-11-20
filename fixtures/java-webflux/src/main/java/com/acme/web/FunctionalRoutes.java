package com.acme.web;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.MediaType;
import org.springframework.web.reactive.function.server.RequestPredicates;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;

@Configuration
public class FunctionalRoutes {
    private static final String BASE = "/v2";

    private final UserHandler users = new UserHandler();

    // Classic static form: route(...).andRoute(...).andNest(...).
    @Bean
    public RouterFunction<ServerResponse> userRoutes(UserHandler handler) {
        return RouterFunctions
            .route(RequestPredicates.GET("/users"), handler::list)
            .andRoute(RequestPredicates.GET("/users/{id}").and(RequestPredicates.accept(MediaType.APPLICATION_JSON)), handler::get)
            .andRoute(RequestPredicates.POST("/users"), handler::create)
            .andNest(RequestPredicates.path("/admin"),
                RouterFunctions.route(RequestPredicates.DELETE("/users/{id}"), handler::remove));
    }

    // A field receiver and a static handler.
    @Bean
    public RouterFunction<ServerResponse> overloaded() {
        return RouterFunctions.route(RequestPredicates.GET("/audit"), users::audit)
            .andRoute(RequestPredicates.GET("/health"), OrderHandler::health);
    }

    // Builder form with nested paths.
    @Bean
    public RouterFunction<ServerResponse> orderRoutes(OrderHandler orders) {
        return RouterFunctions.route()
            .path("/api", api -> api
                .nest(RequestPredicates.path("/orders"), nested -> nested
                    .GET("", orders::all)
                    .GET("/{id}", orders::one))
                .POST("/orders", orders::all))
            .PUT("/orders/{id}", RequestPredicates.accept(MediaType.APPLICATION_JSON), orders::one)
            .build();
    }

    // Lambdas: one only delegates, the other builds the response itself.
    @Bean
    public RouterFunction<ServerResponse> lambdas(UserHandler handler) {
        return RouterFunctions.route()
            .GET("/delegating", request -> handler.list(request))
            .GET("/inline", request -> ServerResponse.ok().build())
            .build();
    }

    // Paths that are not literals, an `or` and a predicate the scan cannot read.
    @Bean
    public RouterFunction<ServerResponse> dynamic(UserHandler handler) {
        return RouterFunctions.route(RequestPredicates.GET(BASE + "/items"), handler::list)
            .andRoute(RequestPredicates.GET("/a").or(RequestPredicates.POST("/b")), handler::create)
            .andRoute(adminOnly(), handler::remove);
    }

    // Not a router: no RouterFunction is returned.
    public String notARouter() {
        return RouterFunctions.route().toString();
    }

    private static org.springframework.web.reactive.function.server.RequestPredicate adminOnly() {
        return RequestPredicates.all();
    }
}
