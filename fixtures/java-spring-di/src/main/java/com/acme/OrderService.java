package com.acme;

import jakarta.inject.Inject;
import java.util.List;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

@Service
public class OrderService {
    // Field injection: the one @Primary notifier.
    @Autowired
    private Notifier notifier;

    // @Qualifier picks the bean named "sms".
    @Autowired
    @Qualifier("sms")
    private Notifier smsNotifier;

    // Provided by a @Bean method that returns an interface: the edge goes to AppConfig.
    @Inject
    private Cache cache;

    // Every Notifier.
    @Autowired
    private List<Notifier> allNotifiers;

    // Optional<T> is T.
    @Autowired
    private Optional<AuditLog> auditLog;

    private UserService users;
    private Mailer mailer;

    // Setter injection.
    @Autowired
    public void setUsers(UserService users) {
        this.users = users;
    }

    @Inject
    public void setMailer(Mailer mailer) {
        this.mailer = mailer;
    }
}
