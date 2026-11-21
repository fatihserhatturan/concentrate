package com.acme.orders.dao;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class OrderJdbcDao {
  private final JdbcTemplate jdbcTemplate;

  public OrderJdbcDao(JdbcTemplate jdbcTemplate) {
    this.jdbcTemplate = jdbcTemplate;
  }

  public int markShipped(long id) {
    return jdbcTemplate.update("UPDATE ORDERS SET status = 'SHIPPED' WHERE id = ?", id);
  }

  public Long openCount() {
    return jdbcTemplate.queryForObject("SELECT count(*) FROM orders WHERE status = 'OPEN'", Long.class);
  }
}
