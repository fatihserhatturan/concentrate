package com.acme;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class Junit5Test {
    @Test
    void plain() {}

    @ParameterizedTest
    @ValueSource(ints = {1, 2})
    void param(int n) {}

    void helper() {}                                  // not a test
}
