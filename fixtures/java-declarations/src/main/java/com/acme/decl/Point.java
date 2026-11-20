package com.acme.decl;

public record Point(int x, int y) {
    public Point {
        if (x < 0) throw new IllegalArgumentException();
    }

    public int sum() {
        return x + y;
    }
}
