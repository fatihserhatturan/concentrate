package com.acme;

import jakarta.inject.Singleton;

@Singleton
public class FixedClock implements Clock {
    public long now() { return 1L; }
}
