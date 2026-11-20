package com.acme;

import jakarta.inject.Named;

@Named("systemClock")
public class SystemClock implements Clock {
    public long now() { return 0L; }
}
