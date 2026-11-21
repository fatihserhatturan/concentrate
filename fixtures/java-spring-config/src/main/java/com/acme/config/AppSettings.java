package com.acme.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class AppSettings {
  @Value("${app.name}")
  private String name;

  @Value("${app.timeout:60}")
  private int timeout;

  // No such key anywhere: the default is the value.
  @Value("${app.greeting:hello}")
  private String greeting;

  // An environment variable that is no key of a config file.
  @Value("${REGION}")
  private String region;

  // Not a placeholder: a literal and a SpEL expression.
  @Value("literal")
  private String literal;
  @Value("#{systemProperties['user.name']}")
  private String user;

  private String url;

  public AppSettings(@Value("${spring.datasource.url}") String url) {
    this.url = url;
  }

  @Value("${app.mail.from-address}")
  public void setFrom(String from) {}

  public String label() { return name + greeting; }
  public int limit() { return this.timeout; }
  public String where() { return region; }
  public String unrelated(String name) { return name; }
}
