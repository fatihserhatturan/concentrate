package com.acme.decl;

public enum Level {
    LOW(1),
    HIGH(10) {
        @Override
        public String label() {
            return "high!";
        }
    };

    private final int weight;

    Level(int weight) {
        this.weight = weight;
    }

    public int weight() {
        return weight;
    }

    public String label() {
        return name().toLowerCase();
    }
}
