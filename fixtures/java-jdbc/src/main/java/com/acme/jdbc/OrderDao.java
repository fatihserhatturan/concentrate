package com.acme.jdbc;

import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class OrderDao {
  private final NamedParameterJdbcTemplate named;
  private final JdbcClient client;

  public OrderDao(NamedParameterJdbcTemplate named, JdbcClient client) {
    this.named = named;
    this.client = client;
  }

  public List<Map<String, Object>> ordersOf(long customer) {
    return named.queryForList(Queries.ORDERS_OF, Map.of("customer", customer));
  }

  public int cancel(long id) {
    return client.sql("UPDATE orders SET status = 'cancelled' WHERE id = :id").param("id", id).update();
  }

  public long count() {
    return client.sql("SELECT count(*) FROM orders").query(Long.class).single();
  }
}
