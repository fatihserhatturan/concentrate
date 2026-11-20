package com.acme.api;

class Internal {                            // package-private, used by Facade
    String go() { return new UsedApi().pkgUsed(); }
}

class Dead {                                // package-private, never used -> unused
    void nothing() {}
}
