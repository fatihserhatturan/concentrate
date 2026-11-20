package com.acme.orders.service;

import com.acme.orders.client.AuditClient;
import com.acme.orders.client.NotifyGateway;
import com.acme.orders.config.LimitProperties;
import com.acme.orders.dao.OrderJdbcDao;
import com.acme.orders.domain.OrderEntity;
import com.acme.orders.mapper.OrderMapper;
import com.acme.orders.repo.OrderRepository;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class OrderService {
  private final OrderRepository repository;
  private final OrderJdbcDao dao;
  private final OrderMapper mapper;
  private final AuditClient audit;
  private final NotifyGateway notifier;
  private final LimitProperties limits;

  @Value("${app.name}")
  private String appName;

  public OrderService(OrderRepository repository, OrderJdbcDao dao, OrderMapper mapper, AuditClient audit, NotifyGateway notifier, LimitProperties limits) {
    this.repository = repository;
    this.dao = dao;
    this.mapper = mapper;
    this.audit = audit;
    this.notifier = notifier;
    this.limits = limits;
  }

  public OrderEntity place(OrderEntity order) {
    if (dao.openCount() >= limits.getMaxOpen()) {
      throw new IllegalStateException(appName + ": too many open orders");
    }
    audit.record("placed");
    return repository.save(order);
  }

  public List<OrderEntity> open() {
    return repository.findByStatus("OPEN");
  }

  public int ship(long id) {
    notifier.send("shipped " + id).block();
    return dao.markShipped(id);
  }

  public List<String> forCustomer(String email) {
    return mapper.byCustomer(email);
  }

  public int cleanup() {
    return mapper.purgeCancelled();
  }

  public String region() {
    return System.getenv("ORDERS_REGION");
  }
}
