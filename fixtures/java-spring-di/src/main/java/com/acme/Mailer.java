package com.acme;

public class Mailer {
    private final Notifier notifier;

    public Mailer(Notifier notifier) {
        this.notifier = notifier;
    }
}
