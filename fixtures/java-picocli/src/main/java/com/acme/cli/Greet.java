package com.acme.cli;

import java.util.concurrent.Callable;
import picocli.CommandLine;
import picocli.CommandLine.Command;

@Command(name = "greet", description = "Greets")
public class Greet implements Callable<Integer> {
    public static void main(String[] args) {
        System.exit(new CommandLine(new Greet()).execute(args));
    }

    @Override
    public Integer call() {
        return 0;
    }
}
