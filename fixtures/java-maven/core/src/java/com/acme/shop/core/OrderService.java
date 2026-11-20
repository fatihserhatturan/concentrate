package com.acme.shop.core;

import com.acme.shop.util.Money;
import com.acme.shop.util.Slugs;

public class OrderService {
    public Order create(String title, long cents) {
        return new Order(Slugs.slug(title), cents);
    }

    public String describe(Order order) {
        return order.title() + ": " + Money.format(order.cents());
    }
}
