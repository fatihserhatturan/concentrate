package com.acme.billing.web;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/invoices")
public class InvoiceController {
  @GetMapping("/{id}")
  public String get(@PathVariable long id) { return "invoice"; }

  @PostMapping
  public String create(@RequestBody String body) { return body; }

  @DeleteMapping("/{id}")
  public void cancel(@PathVariable long id) {}

  @GetMapping("/{id}/lines")
  public String lines(@PathVariable long id) { return ""; }
}
