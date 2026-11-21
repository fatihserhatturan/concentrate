package com.acme.billing.client;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;

// No url: a load-balanced service known by its name.
@FeignClient("inventory")
public interface InventoryClient {
  @GetMapping("/stock/{sku}")
  int stock(@PathVariable("sku") String sku);
}
