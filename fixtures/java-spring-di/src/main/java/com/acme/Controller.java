package com.acme;

import jakarta.inject.Inject;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class Controller {
    private final OrderService orders;
    private final Notifier notifier;

    // Two constructors: the @Inject one is used.
    @Inject
    public Controller(OrderService orders, Notifier notifier) {
        this.orders = orders;
        this.notifier = notifier;
    }

    public Controller(OrderService orders) {
        this(orders, null);
    }
}
