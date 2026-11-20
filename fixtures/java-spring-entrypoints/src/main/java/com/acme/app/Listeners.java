package com.acme.app;

import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.context.event.EventListener;
import org.springframework.jms.annotation.JmsListener;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.transaction.event.TransactionalEventListener;

public class Listeners {
    static final String ORDERS = "orders";

    @KafkaListener(topics = "payments")
    public void onPayment(String message) {
    }

    @KafkaListener(topics = {"a", "b"})
    public void onAorB(String message) {
    }

    @KafkaListener(topics = ORDERS)
    public void onOrder(String message) {
    }

    @RabbitListener(queues = "mail")
    public void onMail(String message) {
    }

    @JmsListener(destination = "alerts")
    public void onAlert(String message) {
    }

    @EventListener
    public void onStarted(OrderPlaced event) {
    }

    @EventListener(classes = OrderShipped.class)
    public void onShipped() {
    }

    @TransactionalEventListener
    public void afterCommit(OrderPlaced event) {
    }

    public void notListening(String message) {
    }
}
