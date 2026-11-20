package com.acme.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class AppConfig {
  // The bean's fields bind to app.feature.*.
  @Bean
  @ConfigurationProperties(prefix = "app.feature")
  public FeatureProperties featureProperties() {
    return new FeatureProperties();
  }

  @Bean
  public String dataSourceUrl(@Value("${spring.datasource.url}") String url, @Value("${spring.datasource.username:sa}") String user) {
    return url + user;
  }
}
