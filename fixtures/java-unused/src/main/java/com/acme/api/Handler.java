package com.acme.api;

public interface Handler {
    void handle();                          // implemented elsewhere, called in Main
    void unimplementedHook();               // implemented by Impl but never called
}
