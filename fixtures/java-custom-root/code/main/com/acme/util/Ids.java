package com.acme.util;

public final class Ids {
    private Ids() {}

    public static final String PREFIX = "id-";

    public static String next() {
        return PREFIX + System.nanoTime();
    }
}
