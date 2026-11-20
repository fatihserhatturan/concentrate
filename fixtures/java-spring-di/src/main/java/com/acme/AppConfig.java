package com.acme;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class AppConfig {
    @Bean
    public Mailer mailer(@Qualifier("sms") Notifier notifier) {
        return new Mailer(notifier);
    }

    @Bean("sessionCache")
    public Cache cache(AuditLog log) {
        return null;
    }
}
