package com.acme.billing.config;

import com.acme.billing.client.LegacyApi;
import feign.Feign;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class LegacyConfig {
  @Bean
  public LegacyApi legacyApi() {
    return Feign.builder().target(LegacyApi.class, "http://localhost:8080");
  }
}
