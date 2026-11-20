package com.acme.rest;

public class HealthResource implements HealthApi {
  public String status() { return "ok"; }

  public String live() { return "live"; }
}
