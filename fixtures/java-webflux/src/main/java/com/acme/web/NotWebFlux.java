package com.acme.web;

// The same shapes without any WebFlux import: ignored.
public class NotWebFlux {
    interface RouterFunction<T> {}

    RouterFunction<String> build(Object handler) {
        return route(GET("/x"), handler);
    }

    static RouterFunction<String> route(Object predicate, Object handler) {
        return null;
    }

    static Object GET(String path) {
        return path;
    }
}
