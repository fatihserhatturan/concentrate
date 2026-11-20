import com.acme.util.Ids;

// Default-package file: its location carries no package information,
// so only the pom's sourceDirectory says which directory is the root.
public class Bootstrap {
    public static void main(String[] args) {
        System.out.println(Ids.next());
    }
}
