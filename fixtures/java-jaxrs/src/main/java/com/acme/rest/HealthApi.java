package com.acme.rest;

import javax.ws.rs.GET;
import javax.ws.rs.Path;

@Path("/health")
public interface HealthApi {
  @GET
  String status();

  @GET
  @Path("/live")
  String live();
}
