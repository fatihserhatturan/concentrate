package com.acme.orders.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "app.limits")
public class LimitProperties {
  private int maxOpen;
  private int pageSize;

  public int getMaxOpen() { return maxOpen; }
  public int getPageSize() { return pageSize; }
}
