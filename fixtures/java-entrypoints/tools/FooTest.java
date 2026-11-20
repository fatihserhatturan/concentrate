// test-named class outside a test dir, but uses a JUnit annotation
package tools;

import org.junit.Test;

public class FooTest {
    @Test
    public void outside() {}
}
