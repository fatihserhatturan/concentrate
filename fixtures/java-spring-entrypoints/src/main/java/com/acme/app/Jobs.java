package com.acme.app;

import org.springframework.scheduling.annotation.Scheduled;

public class Jobs {
    static final String NIGHTLY = "0 0 3 * * *";

    @Scheduled(cron = "0 * * * * *")
    public void everyMinute() {
    }

    @Scheduled(fixedRate = 5000)
    public void everyFiveSeconds() {
    }

    @Scheduled(fixedDelay = 1000)
    public void afterOneSecond() {
    }

    @Scheduled(cron = NIGHTLY)
    public void nightly() {
    }
}
