package com.acme.decl;

public class Box<T extends Comparable<T>> {
    private T value;

    public Box(T value) {
        this.value = value;
    }

    public T get() {
        return value;
    }

    public <R> R map(java.util.function.Function<T, R> f) {
        return f.apply(value);
    }

    public static <E extends Comparable<E>> Box<E> of(E e) {
        return new Box<>(e);
    }
}
