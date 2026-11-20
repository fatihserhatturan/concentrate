package com.acme.decl;

import java.util.ArrayList;
import java.util.List;

public class Outer {
    private int state;

    public static class Nested {          // nested static class
        public int n() { return 1; }
    }

    public class Inner {                  // inner (non-static) class
        public int s() { return state; }
    }

    @Deprecated
    public void legacy() {}

    @SuppressWarnings({"a", "b"})
    public List<Object> work() {
        class Local {                     // local class
            int v() { return 2; }
        }
        Runnable r = new Runnable() {     // anonymous class
            @Override
            public void run() {
                System.out.println(new Local().v());
            }
        };
        r.run();
        return new ArrayList<>();
    }

    @Retry(times = 3)
    public void flaky() {}

    @Retry(times = 2, reason = "network")
    protected void flakier() {}
}
