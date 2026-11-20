package com.acme.shop.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;

@Embeddable
public class Address {
  private String street;

  @Column(name = "city_name")
  private String city;
}
