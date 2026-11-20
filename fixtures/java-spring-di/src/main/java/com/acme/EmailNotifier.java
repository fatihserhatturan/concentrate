package com.acme;

import org.springframework.context.annotation.Primary;
import org.springframework.stereotype.Component;

@Primary
@Component
public class EmailNotifier implements Notifier {
    public void send(String message) {}
}
