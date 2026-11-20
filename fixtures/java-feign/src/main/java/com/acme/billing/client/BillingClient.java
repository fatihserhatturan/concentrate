package com.acme.billing.client;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;

@FeignClient(name = "billing", url = "${services.billing.url}", path = "/api/invoices")
public interface BillingClient {
  @GetMapping("/{id}")
  String get(@PathVariable("id") long id);

  @PostMapping
  String create(@RequestBody String body);

  @DeleteMapping("/{id}")
  void cancel(@PathVariable("id") long id);

  @RequestMapping(method = RequestMethod.GET, value = "/{id}/lines")
  String lines(@PathVariable("id") long id);
}
