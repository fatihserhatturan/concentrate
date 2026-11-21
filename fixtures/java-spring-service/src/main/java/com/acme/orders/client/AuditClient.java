package com.acme.orders.client;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;

@FeignClient(name = "audit", url = "${services.audit.url}", path = "/api/audit")
public interface AuditClient {
  @PostMapping("/events")
  void record(@RequestBody String event);
}
