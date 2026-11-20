package com.acme.shop.util;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class MoneyTest {
    @Test
    void formats() {
        assertEquals("1.05", Money.format(105));
    }
}
