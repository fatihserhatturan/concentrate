package com.acme;

import org.springframework.stereotype.Component;

@Component("sms")
public class SmsNotifier implements Notifier {
    public void send(String message) {}
}
