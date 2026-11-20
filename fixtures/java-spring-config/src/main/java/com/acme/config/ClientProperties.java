package com.acme.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties("app.client")
public record ClientProperties(String baseUrl, String connectTimeout) {}
