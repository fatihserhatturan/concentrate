package com.acme.own;

import com.acme.own.KafkaListener;

public class OwnJobs {
    // Same package, no import: the user's own annotation.
    @Scheduled(cron = "* * * * * *")
    public void notSpring() {
    }

    // Single-type import of the user's own annotation.
    @KafkaListener(topics = "x")
    public void notKafka() {
    }
}
