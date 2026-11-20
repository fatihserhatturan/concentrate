package com.acme;

import jakarta.inject.Inject;
import org.springframework.stereotype.Component;

@Component
public class ClockUser {
    // Two Clock implementations, no qualifier, no @Primary: ambiguous, counted.
    @Inject
    private Clock clock;

    // The bean named like the field breaks the tie.
    @Inject
    private Clock systemClock;
}
