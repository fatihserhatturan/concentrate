package com.acme.config;

import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "app.mail")
public class MailProperties {
  private String host;
  private int port;
  private String fromAddress;
  private List<String> allowedSenders;
  private Retry retry = new Retry();

  public String getHost() { return host; }
  public void setHost(String host) { this.host = host; }
  public int getPort() { return port; }
  public String getFromAddress() { return fromAddress; }
  public Retry getRetry() { return retry; }

  public static class Retry {
    private int maxAttempts;
    public int getMaxAttempts() { return maxAttempts; }
  }
}
