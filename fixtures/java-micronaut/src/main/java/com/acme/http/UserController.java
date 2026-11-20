package com.acme.http;

import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Delete;
import io.micronaut.http.annotation.Get;
import io.micronaut.http.annotation.Patch;
import io.micronaut.http.annotation.Post;
import io.micronaut.http.annotation.Put;

@Controller("/users")
public class UserController {
  @Get
  public String list() { return "[]"; }

  @Get("/{id}")
  public String get(String id) { return id; }

  @Get(uri = "/by-name/{name}")
  public String byName(String name) { return name; }

  @Get(uris = {"/a", "/b"})
  public String multi() { return ""; }

  @Post
  public String create(String body) { return body; }

  @Put("/{id}")
  public String update(String id, String body) { return body; }

  @Patch("/{id}")
  public String patch(String id, String body) { return body; }

  @Delete("/{id}")
  public void delete(String id) {}
}
