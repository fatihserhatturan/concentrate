package com.acme.rest;

import javax.ws.rs.GET;
import javax.ws.rs.HEAD;
import javax.ws.rs.Path;

// No class @Path: reached through the locator above, so it has no root Route.
public class OrderResource {
  @GET
  public String list() { return "[]"; }

  @HEAD
  @Path("/count")
  public void count() {}
}
