package com.acme.app;

import io.micronaut.scheduling.annotation.Scheduled;

public class MicronautJobs {
    @Scheduled(fixedRate = "10s")
    public void tick() {
    }
}
