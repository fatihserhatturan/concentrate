package com.acme.billing;

import com.acme.billing.client.BillingClient;
import com.acme.billing.client.InventoryClient;
import com.acme.billing.client.LegacyApi;
import org.springframework.stereotype.Service;

@Service
public class InvoiceFacade {
  private final BillingClient billing;
  private final InventoryClient inventory;
  private final LegacyApi legacy;

  public InvoiceFacade(BillingClient billing, InventoryClient inventory, LegacyApi legacy) {
    this.billing = billing;
    this.inventory = inventory;
    this.legacy = legacy;
  }

  public String show(long id) { return billing.get(id); }

  public String open(String body) { return billing.create(body); }

  public void cancel(long id) { billing.cancel(id); }

  public String lines(long id) { return billing.lines(id); }

  public int stock(String sku) { return inventory.stock(sku); }

  public String ping() { return legacy.status(); }
}
