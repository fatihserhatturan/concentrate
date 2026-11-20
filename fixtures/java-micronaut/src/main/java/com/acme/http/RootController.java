package com.acme.http;

import io.micronaut.http.annotation.*;

@Controller
public class RootController {
  @Get("/")
  public String home() { return "home"; }

  @Get("/status")
  public String status() { return "ok"; }
}
