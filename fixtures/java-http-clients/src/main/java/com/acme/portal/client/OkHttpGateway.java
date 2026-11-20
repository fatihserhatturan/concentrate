package com.acme.portal.client;

import com.acme.portal.config.Urls;
import java.io.IOException;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

public class OkHttpGateway {
  private final OkHttpClient client = new OkHttpClient();

  public Response remove(long id) throws IOException {
    Request request = new Request.Builder().url(Urls.USERS + "/" + id).delete().build();
    return client.newCall(request).execute();
  }

  public Response find(long id) throws IOException {
    Request request = new Request.Builder().url(Urls.USERS + "/" + id).build();
    return client.newCall(request).execute();
  }
}
