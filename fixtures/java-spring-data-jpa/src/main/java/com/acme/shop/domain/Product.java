package com.acme.shop.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;

@Entity(name = "CatalogProduct")
public class Product extends BaseEntity {
  @Column(name = "product_name")
  private String name;

  private int stockLevel;
}
