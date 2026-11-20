package com.acme.jdbc;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import javax.sql.DataSource;
import org.springframework.jdbc.core.simple.SimpleJdbcInsert;

public class AuditDao {
  private final DataSource dataSource;
  private final SimpleJdbcInsert insert;

  public AuditDao(DataSource dataSource) {
    this.dataSource = dataSource;
    this.insert = new SimpleJdbcInsert(dataSource).withTableName("audit_log");
  }

  public void record(String message) throws SQLException {
    try (Connection connection = dataSource.getConnection();
         PreparedStatement statement = connection.prepareStatement("INSERT INTO audit_events (message) VALUES (?)")) {
      statement.setString(1, message);
      statement.executeUpdate();
    }
  }

  public void cleanup(Connection connection) throws SQLException {
    try (Statement statement = connection.createStatement()) {
      statement.executeUpdate("DELETE FROM audit_events WHERE created_at < now() - interval '30 days'");
    }
  }

  public void log(String message) {
    new SimpleJdbcInsert(dataSource).withTableName("audit_trail").execute(java.util.Map.of("message", message));
  }
}
