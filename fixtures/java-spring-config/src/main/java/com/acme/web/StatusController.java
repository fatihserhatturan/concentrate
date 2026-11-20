package com.acme.web;

import com.acme.config.AppSettings;
import com.acme.config.ClientProperties;
import com.acme.config.MailProperties;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class StatusController {
  private final MailProperties mail;
  private final ClientProperties client;
  private final AppSettings settings;

  public StatusController(MailProperties mail, ClientProperties client, AppSettings settings) {
    this.mail = mail;
    this.client = client;
    this.settings = settings;
  }

  @GetMapping("/status")
  public String status() {
    return settings.label() + mail.getHost() + System.getenv("RELEASE");
  }

  @GetMapping("/client")
  public String client() { return client.baseUrl(); }

  @GetMapping("/retries")
  public int retries() { return mail.getRetry().getMaxAttempts(); }

  @GetMapping("/sender")
  public String sender(@Value("${app.mail.from-address}") String from) { return from; }
}
