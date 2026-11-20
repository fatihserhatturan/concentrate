package com.acme.jdbc;

// Not JDBC: a user class whose methods are named like JdbcTemplate's.
public class SearchIndex {
  public Object query(String text) { return text; }

  public int update(String text) { return 0; }

  public void run() {
    query("SELECT * FROM documents");
    update("UPDATE documents SET x = 1");
  }
}
