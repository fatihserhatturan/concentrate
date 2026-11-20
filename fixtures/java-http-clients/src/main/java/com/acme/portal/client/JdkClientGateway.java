package com.acme.portal.client;

import com.acme.portal.config.Urls;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public class JdkClientGateway {
  private final HttpClient client = HttpClient.newHttpClient();

  public String health() throws IOException, InterruptedException {
    HttpRequest request = HttpRequest.newBuilder(URI.create(Urls.ORIGIN + "/health")).GET().build();
    return client.send(request, HttpResponse.BodyHandlers.ofString()).body();
  }

  public void create(String json) throws IOException, InterruptedException {
    String url = Urls.ORIGIN + "/api/users";
    HttpRequest request = HttpRequest.newBuilder()
        .uri(URI.create(url))
        .header("Content-Type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(json))
        .build();
    client.sendAsync(request, HttpResponse.BodyHandlers.ofString());
  }

  public void replace(long id) throws IOException, InterruptedException {
    HttpRequest request = HttpRequest.newBuilder().uri(URI.create(Urls.USERS + "/" + id)).method("PUT", HttpRequest.BodyPublishers.noBody()).build();
    client.send(request, HttpResponse.BodyHandlers.discarding());
  }
}
