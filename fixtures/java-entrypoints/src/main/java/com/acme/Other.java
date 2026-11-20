package com.acme;

public class Other {
    public static void main(int count) {              // NOT an entrypoint: wrong params
    }

    public void main(String[] args) {                 // NOT an entrypoint: non-static
    }
}
