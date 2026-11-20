package com.acme.billing.client;

import feign.RequestLine;

public interface LegacyApi {
  @RequestLine("GET /status")
  String status();
}
