package com.acme.api;

import com.acme.api.GetMapping;
import com.acme.api.RestController;

// Same simple names from another package: no routes.
@RestController
public class NotSpringController {
  @GetMapping("/fake")
  public String fake() { return ""; }
}
