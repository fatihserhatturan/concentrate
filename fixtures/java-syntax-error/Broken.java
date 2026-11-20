public class Broken {
    int before() { return 1; }

    int middle() {
        return 1 +;
    }

    int after() { return before(); }
}
