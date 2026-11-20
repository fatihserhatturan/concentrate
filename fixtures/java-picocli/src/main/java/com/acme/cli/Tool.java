package com.acme.cli;

import picocli.CommandLine.Command;

@Command(name = "tool")
public class Tool implements Runnable {
    @Override
    public void run() {
    }

    @Command(name = "status")
    int status() {
        return 0;
    }

    @Command
    void sync() {
    }

    void helper() {
    }
}
