package com.acme.orders.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "orders")
public class OrderEntity {
  @Id
  private Long id;

  @Column(name = "customer_email")
  private String customerEmail;

  private String status;
}
