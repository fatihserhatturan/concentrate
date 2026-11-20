package com.acme.app;

import com.acme.api.Handler;

public class Impl implements Handler {
    @Override
    public void handle() {}                 // @Override: not unused

    @Override
    public void unimplementedHook() {}

    @Override
    public String toString() { return "impl"; }

    public void extra() {}                  // public, never called
}
