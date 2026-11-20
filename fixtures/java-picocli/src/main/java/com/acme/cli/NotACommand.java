package com.acme.cli;

public class NotACommand implements Runnable {
    @Command(name = "own")
    public void run() {
    }

    @interface Command {
        String name();
    }
}
