package com.acme.rest;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;

@Path(Paths.ADMIN)
public class AdminResource {
  @GET
  @Path("/stats")
  public String stats() { return ""; }
}
