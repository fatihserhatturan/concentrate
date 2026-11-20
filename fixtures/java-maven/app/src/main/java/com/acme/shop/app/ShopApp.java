package com.acme.shop.app;

import com.acme.shop.core.Order;
import com.acme.shop.core.OrderService;

public class ShopApp {
    public static void main(String[] args) {
        OrderService service = new OrderService();
        Order order = service.create("Blue Mug", 1250);
        System.out.println(service.describe(order));
    }
}
