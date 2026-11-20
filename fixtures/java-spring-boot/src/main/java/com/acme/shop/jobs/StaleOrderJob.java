package com.acme.shop.jobs;

import com.acme.shop.service.OrderService;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class StaleOrderJob {
    private final OrderService orders;

    public StaleOrderJob(OrderService orders) {
        this.orders = orders;
    }

    @Scheduled(cron = "0 0 * * * *")
    public void expire() {
        orders.expireStale();
    }
}
