package com.acme.jdbc;

import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class UserDao {
  private final JdbcTemplate jdbcTemplate;

  public UserDao(JdbcTemplate jdbcTemplate) {
    this.jdbcTemplate = jdbcTemplate;
  }

  public Map<String, Object> find(long id) {
    return jdbcTemplate.queryForMap(Queries.FIND_USER, id);
  }

  public List<String> names() {
    return jdbcTemplate.queryForList("SELECT name FROM users", String.class);
  }

  public int rename(long id, String name) {
    String sql = "UPDATE users SET name = ? WHERE id = ?";
    return jdbcTemplate.update(sql, name, id);
  }

  public void purge() {
    jdbcTemplate.execute("""
        DELETE FROM sessions
        WHERE expired_at < now()
        """);
  }

  public int[] insertAll(List<Object[]> rows) {
    return jdbcTemplate.batchUpdate("INSERT INTO users (name, email) VALUES (?, ?)", rows);
  }

  public Object dynamic(String table) {
    return jdbcTemplate.queryForList("SELECT * FROM " + table, Object.class);
  }

  public Object fromParameter(String sql) {
    return jdbcTemplate.queryForList(sql, Object.class);
  }
}
