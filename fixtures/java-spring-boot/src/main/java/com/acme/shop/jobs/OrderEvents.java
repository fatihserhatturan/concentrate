package com.acme.shop.jobs;

import com.acme.shop.service.OrderService;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class OrderEvents {
    private final OrderService orders;

    public OrderEvents(OrderService orders) {
        this.orders = orders;
    }

    @KafkaListener(topics = "orders.placed")
    public void onPlaced(String payload) {
        orders.place(payload);
    }
}
