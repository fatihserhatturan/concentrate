package com.acme.shop.domain;

import jakarta.persistence.Entity;

@Entity
public class CardPayment extends Payment {
  private String cardLast4;
}
