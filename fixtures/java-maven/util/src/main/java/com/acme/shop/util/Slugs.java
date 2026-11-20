package com.acme.shop.util;

public final class Slugs {
    private Slugs() {}

    public static String slug(String s) {
        return s.trim().toLowerCase().replace(' ', '-');
    }
}
