package com.acme.config;

import static java.lang.System.getenv;

import java.util.HashMap;
import java.util.Map;
import java.util.Properties;
import org.springframework.core.env.Environment;

public class EnvUsage {
  private static final String MODE = System.getenv("APP_MODE");
  private final Environment environment;
  private final Properties properties = new Properties();

  public EnvUsage(Environment environment) { this.environment = environment; }

  public String password() { return System.getenv("DB_PASSWORD"); }
  public String region() { return System.getenv(EnvKeys.REGION); }
  public String prefixed() { return System.getenv(EnvKeys.PREFIX + "TOKEN"); }
  public String viaMap() { return System.getenv().get("LOG_LEVEL"); }
  public String viaLocal() {
    Map<String, String> env = System.getenv();
    return env.getOrDefault("TZ", "UTC");
  }
  public String viaImport() { return getenv("HOME_DIR"); }
  public String dynamic(String name) { return System.getenv(name); }

  // Properties, not environment variables.
  public String property() { return System.getProperty("user.dir"); }
  public String fromProperties() { return properties.getProperty("app.mail.host"); }
  public String notEnv() {
    Map<String, String> env = new HashMap<>();
    return env.get("NOT_ENV");
  }

  public String host() { return environment.getProperty("app.mail.host"); }
  public Boolean enabled() { return environment.getRequiredProperty("app.feature.enabled", Boolean.class); }
  public String port() { return environment.getProperty("app.mail.port", "25"); }
  public String viaEnvVar() { return environment.getProperty("SPRING_DEMO_TOKEN"); }
}
