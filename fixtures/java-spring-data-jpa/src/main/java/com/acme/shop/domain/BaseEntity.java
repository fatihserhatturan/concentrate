package com.acme.shop.domain;

import jakarta.persistence.Column;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.persistence.MappedSuperclass;
import java.time.Instant;

@MappedSuperclass
public abstract class BaseEntity {
  @Id
  @GeneratedValue
  private Long id;

  @Column(name = "created_at")
  private Instant createdAt;

  public Long getId() { return id; }
}
