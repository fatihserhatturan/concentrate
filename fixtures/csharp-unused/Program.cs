using Acme.Lib;

namespace Acme.App;

public class Program
{
    public static void Main()
    {
        var u = new UsedPublic();
        u.UsedMethod();
        u.UsedInternal();
        u.UsedProp = 1;
        _ = new UsedInternalClass();
        IThing t = new ThingImpl();
        t.Do();
        _ = UsedEnum.A;
        _ = 2.Double();
    }
}
