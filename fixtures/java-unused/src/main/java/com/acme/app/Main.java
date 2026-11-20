package com.acme.app;

import com.acme.api.Facade;
import com.acme.api.Handler;
import com.acme.api.UsedApi;

public class Main {
    public static void main(String[] args) {  // entrypoint: never unused
        Handler h = new Impl();
        h.handle();
        System.out.println(new UsedApi().used() + new Facade().run());
    }

    static void unusedStatic() {}            // package-private static, unused
}
