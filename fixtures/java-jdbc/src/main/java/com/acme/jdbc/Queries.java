package com.acme.jdbc;

public final class Queries {
  public static final String USER_COLUMNS = "id, name, email";
  public static final String FIND_USER = "SELECT " + USER_COLUMNS + " FROM users WHERE id = ?";
  public static final String ORDERS_OF = "SELECT o.id, o.total FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.id = :customer";

  private Queries() {}
}
