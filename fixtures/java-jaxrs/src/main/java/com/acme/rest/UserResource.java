package com.acme.rest;

import jakarta.ws.rs.DELETE;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.PUT;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;

@Path("/users")
public class UserResource {
  @GET
  public String list() { return "[]"; }

  @GET
  @Path("{id}")
  public String get(@PathParam("id") String id) { return id; }

  @POST
  public String create(String body) { return body; }

  @PUT
  @Path("/{id}")
  public String update(@PathParam("id") String id, String body) { return body; }

  @DELETE
  @Path("/{id}")
  public void delete(@PathParam("id") String id) {}

  // Sub-resource locator: no HTTP method, no Route.
  @Path("/{id}/orders")
  public OrderResource orders(@PathParam("id") String id) { return new OrderResource(); }
}
