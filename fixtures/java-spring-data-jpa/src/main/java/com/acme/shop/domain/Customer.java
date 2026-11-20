package com.acme.shop.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Embedded;
import jakarta.persistence.Entity;
import jakarta.persistence.OneToMany;
import jakarta.persistence.Table;
import jakarta.persistence.Transient;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "customers", schema = "shop")
public class Customer extends BaseEntity {
  @Column(name = "email_address", nullable = false)
  private String email;

  private String status;

  @Embedded
  private Address address;

  @OneToMany(mappedBy = "customer")
  private List<Order> orders = new ArrayList<>();

  @Transient
  private String displayName;

  private static final String KIND = "customer";
}
