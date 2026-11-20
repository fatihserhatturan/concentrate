package com.acme;

public class App {
    public static void main(String[] args) {          // entrypoint
        System.out.println("app");
    }

    public void main(String arg) {                    // NOT an entrypoint: non-static, wrong params
    }
}
