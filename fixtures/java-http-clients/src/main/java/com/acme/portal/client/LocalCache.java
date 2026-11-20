package com.acme.portal.client;

import java.util.HashMap;
import java.util.Map;

// Not an HTTP client: methods that only look like one.
public class LocalCache {
  private final Map<String, String> entries = new HashMap<>();

  public String get(String key) { return entries.get(key); }

  public String getForObject(String url, Class<String> type) { return entries.get(url); }

  public void delete(String url) { entries.remove(url); }

  public String warm() {
    delete("/api/users/1");
    return getForObject("/api/users/1", String.class) + get("/health");
  }
}
